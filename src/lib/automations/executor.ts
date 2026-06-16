import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendEmail, emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { sendSms, smsIsConfigured } from "@/lib/comms/twilio";
import { resolveMergeTags } from "./merge-tags";
import { publishStep } from "./qstash";
import { buildUnsubscribeUrl } from "./unsubscribe-token";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { computeWindowDeferralSeconds } from "@/lib/time/window";
import type {
  AutomationDoc,
  ExecutionDoc,
  ExecutionStepHistoryEntry,
  InstantResponseConfig,
  MessageTemplateDoc,
  SendWindow,
  StepChannel,
  StoppedReason,
} from "@/types";
import type { Contact } from "@/types/contacts";
import type { AgencyDoc, SubAccountDoc } from "@/types";

/**
 * Resolved step shape — what the executor actually runs at a given index.
 * Derived from the automation's recipe config at execution time.
 */
interface PlannedStep {
  channel: StepChannel;
  templateId: string;
  /** Delay relative to the PREVIOUS step's send (or to trigger if first). */
  delaySeconds: number;
  /** Where the message goes — the contact, or a static recipient (owner notify). */
  recipient:
    | { kind: "contact" }
    | { kind: "static"; address: string };
}

/**
 * Map a recipe config to its ordered step plan. Phase 2 only ships
 * `leadSms`; Phase 3 will append `leadEmail` and `ownerNotify` here.
 */
function planSteps(automation: AutomationDoc): PlannedStep[] {
  switch (automation.recipeType) {
    case "instant_response":
      return planInstantResponse(automation.config);
    default:
      return [];
  }
}

function planInstantResponse(config: InstantResponseConfig): PlannedStep[] {
  const steps: PlannedStep[] = [];
  if (config.leadSms) {
    steps.push({
      channel: "sms",
      templateId: config.leadSms.templateId,
      delaySeconds: Math.max(0, config.leadSms.delaySeconds),
      recipient: { kind: "contact" },
    });
  }
  if (config.leadEmail) {
    steps.push({
      channel: "email",
      templateId: config.leadEmail.templateId,
      delaySeconds: Math.max(0, config.leadEmail.delaySeconds),
      recipient: { kind: "contact" },
    });
  }
  if (config.ownerNotify) {
    steps.push({
      channel: config.ownerNotify.channel,
      templateId: config.ownerNotify.templateId,
      delaySeconds: 0,
      recipient: { kind: "static", address: config.ownerNotify.recipient },
    });
  }
  return steps;
}

interface ExecuteStepInput {
  executionId: string;
  stepIndex: number;
}

/**
 * Run one step of an automation execution. Idempotent: if `stepIndex`
 * already has a history entry, returns without re-sending (handles QStash
 * retries on transient 5xx).
 *
 * Errors during send are caught and recorded in `history` with
 * `success: false`; the execution continues to the next step rather than
 * stalling. Hard errors (no execution doc, no automation, no contact) mark
 * the execution as failed.
 */
export async function executeStep(input: ExecuteStepInput): Promise<void> {
  const db = getAdminDb();
  const execRef = db.collection("automation_executions").doc(input.executionId);
  const execSnap = await execRef.get();
  if (!execSnap.exists) {
    console.warn(
      `[executor] execution ${input.executionId} not found; QStash retry will be ignored`,
    );
    return;
  }
  const execution = execSnap.data() as ExecutionDoc;

  // Idempotency: if this step already has a history row, skip.
  if (execution.history.some((h) => h.stepIndex === input.stepIndex)) {
    console.warn(
      `[executor] execution ${input.executionId} step ${input.stepIndex} already processed — skipping retry`,
    );
    return;
  }

  if (execution.status !== "running") {
    console.warn(
      `[executor] execution ${input.executionId} status=${execution.status}; ignoring step ${input.stepIndex}`,
    );
    return;
  }

  const automationSnap = await db
    .collection("automations")
    .doc(execution.automationId)
    .get();
  if (!automationSnap.exists) {
    await markFailed(execRef, "automation_disabled", "Automation not found");
    return;
  }
  const automation = automationSnap.data() as AutomationDoc;

  if (!automation.enabled) {
    await markStopped(execRef, "automation_disabled");
    return;
  }

  const steps = planSteps(automation);
  const step = steps[input.stepIndex];
  if (!step) {
    await markCompleted(execRef);
    return;
  }

  const contactSnap = await db
    .collection("contacts")
    .doc(execution.contactId)
    .get();
  if (!contactSnap.exists) {
    await markFailed(execRef, "manual", "Contact not found");
    return;
  }
  const contact = { id: contactSnap.id, ...(contactSnap.data() as Omit<Contact, "id">) };

  // Load template, agency, sub-account in parallel for merge-tag context.
  const [templateSnap, subAccountSnap, agencySnap] = await Promise.all([
    db.collection("message_templates").doc(step.templateId).get(),
    db.collection("subAccounts").doc(execution.subAccountId).get(),
    db.collection("agencies").doc(execution.agencyId).get(),
  ]);

  if (!templateSnap.exists) {
    await recordSkip(execRef, contact.id, automation, input.stepIndex, step, {
      success: false,
      error: `Template ${step.templateId} not found`,
    });
    await scheduleOrComplete(execRef, execution, steps, input.stepIndex);
    return;
  }
  const template = templateSnap.data() as MessageTemplateDoc;
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;
  const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

  // Sub-account kill switch — if the operator paused the engine while an
  // execution was in flight, stop here. We mark the execution stopped
  // (not failed) so it's distinguishable in the activity log and can't
  // resume itself from a stale QStash retry.
  if (subAccount?.automationsPaused === true) {
    await markStopped(execRef, "automation_disabled");
    return;
  }

  // Resolve owner snapshot. Falls back to the agency owner uid; if missing,
  // empty strings (the merge-tag resolver tolerates them).
  const ownerSnapshot = await loadOwnerSnapshot(agency);

  // Pre-flight #1 — opt-out. Skip THIS step (don't kill the execution) so
  // remaining steps in the recipe still get a chance to fire on other
  // channels.
  if (
    (step.channel === "sms" && contact.smsOptedOut) ||
    (step.channel === "email" && contact.emailOptedOut)
  ) {
    await recordSkip(execRef, contact.id, automation, input.stepIndex, step, {
      skippedReason: "opt_out",
    });
    await scheduleOrComplete(execRef, execution, steps, input.stepIndex);
    return;
  }

  // Pre-flight #2 — send window. If we're outside the configured hours,
  // reschedule this same step for the next window start. We DO NOT write
  // a history row here — the step hasn't been attempted yet.
  const sendWindow = subAccount?.sendWindow ?? null;
  const deferralSeconds = computeSendWindowDeferral(sendWindow);
  if (deferralSeconds > 0) {
    const nonce = `wnd-${Date.now()}`;
    const result = await publishStep({
      executionId: execution.id,
      stepIndex: input.stepIndex,
      delaySeconds: deferralSeconds,
      nonce,
    });
    if (!result) {
      await markFailed(
        execRef,
        "automation_disabled",
        "QStash publish failed during send-window deferral",
      );
      return;
    }
    await execRef.update({ qstashMessageId: result.messageId });
    return;
  }

  // Send + record. Errors during send are caught and surfaced as a failed
  // history entry rather than throwing.
  const recipientAddress = await resolveRecipient(step, contact);
  if (!recipientAddress) {
    await recordSkip(execRef, contact.id, automation, input.stepIndex, step, {
      skippedReason: "missing_field",
    });
    await scheduleOrComplete(execRef, execution, steps, input.stepIndex);
    return;
  }

  // Build the unsubscribe URL once per send. Always points at the recipient
  // contact (lead steps) — for owner-notify steps the contact is the LEAD,
  // not the owner; the owner is a static recipient outside our DB. We still
  // populate it so the email body's required {{unsubscribeLink}} resolves;
  // clicking it opts the LEAD out, which is fine.
  const unsubscribeLink =
    step.channel === "email" ? buildUnsubscribeUrl(contact.id) : "";

  // Shared merge-tag context. unsubscribeLink is overridden in the HTML
  // pass below (raw URL → anchor tag); everything else stays constant.
  const baseSubject = {
    contact: {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
    },
    owner: ownerSnapshot,
    workspace: { name: subAccount?.name ?? "" },
    bookingLink: subAccount?.bookingLink ?? "",
  } as const;

  const subject = template.subject ?? "";

  // Build text body — {{unsubscribeLink}} resolves to the raw URL. This is
  // both the SMS body and the plain-text fallback for HTML email clients.
  const body = resolveMergeTags(template.body, {
    ...baseSubject,
    unsubscribeLink,
  });
  const resolvedSubject = resolveMergeTags(subject, {
    ...baseSubject,
    unsubscribeLink,
  });

  let success = false;
  let error: string | null = null;
  try {
    if (step.channel === "email") {
      if (!emailIsConfigured()) {
        throw new Error("Email is not configured (RESEND_API_KEY/EMAIL_FROM).");
      }
      // Build a second pass with {{unsubscribeLink}} expanded as an anchor
      // tag so HTML clients render "Unsubscribe" instead of a 100-char URL.
      // Newlines convert to <br>. v1 doesn't escape author-written content
      // since templates are admin-authored, not user input.
      const htmlAnchor = unsubscribeLink
        ? `<a href="${unsubscribeLink}">Unsubscribe</a>`
        : "";
      const htmlInner = resolveMergeTags(template.body, {
        ...baseSubject,
        unsubscribeLink: htmlAnchor,
      }).replace(/\r?\n/g, "<br>");
      const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;
      // Reply-To is the sub-account's nominated address — but only when
      // the recipient is the lead/contact. Owner-notify steps go to a
      // static address (the owner themselves); routing their reply back
      // to the sub-account inbox is pointless.
      const replyTo =
        step.recipient.kind === "contact"
          ? subAccount?.replyToEmail ?? undefined
          : undefined;
      await sendEmail({
        to: recipientAddress,
        subject: resolvedSubject || "(no subject)",
        text: body,
        html,
        replyTo,
        from: tenantFrom(subAccount),
      });
    } else {
      if (!smsIsConfigured()) {
        throw new Error(
          "SMS is not configured (TWILIO_ACCOUNT_SID/_AUTH_TOKEN/_FROM_NUMBER).",
        );
      }
      await sendSms({ to: recipientAddress, body });
    }
    success = true;
  } catch (err) {
    error = err instanceof Error ? err.message : "Send failed";
    console.error(
      `[executor] execution ${execution.id} step ${input.stepIndex} send failed`,
      err,
    );
  }

  const historyEntry: ExecutionStepHistoryEntry = {
    stepIndex: input.stepIndex,
    channel: step.channel,
    templateId: step.templateId,
    recipient: recipientAddress,
    // Timestamp.now() instead of serverTimestamp() — Firestore rejects
    // serverTimestamp() inside array elements (it's a top-level-only sentinel).
    // Server-side wall clock is fine for audit history.
    sentAt: Timestamp.now(),
    success,
    error,
  };

  await execRef.update({
    history: FieldValue.arrayUnion(historyEntry),
    currentStepIndex: input.stepIndex + 1,
  });

  // Activity log entry — content varies on success vs. failure.
  await writeStepActivity(
    contact.id,
    automation,
    historyEntry,
    success,
    template.name,
  );

  await scheduleOrComplete(execRef, execution, steps, input.stepIndex);
}

async function scheduleOrComplete(
  execRef: FirebaseFirestore.DocumentReference,
  execution: ExecutionDoc,
  steps: PlannedStep[],
  justRanIndex: number,
): Promise<void> {
  const next = steps[justRanIndex + 1];
  if (!next) {
    await markCompleted(execRef);
    return;
  }
  const result = await publishStep({
    executionId: execution.id,
    stepIndex: justRanIndex + 1,
    delaySeconds: next.delaySeconds,
  });
  if (!result) {
    await markFailed(execRef, "automation_disabled", "QStash publish failed");
    return;
  }
  await execRef.update({ qstashMessageId: result.messageId });
}

async function markCompleted(
  execRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await execRef.update({
    status: "completed",
    completedAt: FieldValue.serverTimestamp(),
  });
  const snap = await execRef.get();
  const data = snap.data() as ExecutionDoc | undefined;
  if (!data) return;
  const automationSnap = await getAdminDb()
    .collection("automations")
    .doc(data.automationId)
    .get();
  const automationName =
    (automationSnap.data() as AutomationDoc | undefined)?.name ?? "Automation";
  await getAdminDb()
    .collection("contacts")
    .doc(data.contactId)
    .collection("activities")
    .add({
      type: "automation_completed",
      content: `Automation "${automationName}" completed.`,
      createdBy: "automation",
      meta: { automationId: data.automationId, executionId: data.id },
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) =>
      console.warn("[executor] completion activity write failed", err),
    );

  // Public-API webhook event so subscribers see automation runs complete
  // in real time. Useful for "lead nurtured 7 days, hand off to sales"
  // workflows. Fire-and-forget; failures are logged elsewhere.
  void emitWebhookEvent({
    subAccountId: data.subAccountId,
    agencyId: data.agencyId,
    mode: "live",
    type: "automation.completed",
    payload: {
      execution: {
        id: data.id,
        object: "automation_execution",
        automation_id: data.automationId,
        automation_name: automationName,
        contact_id: data.contactId,
        steps_completed: data.history?.length ?? 0,
        completed_at: new Date().toISOString(),
      },
    },
  });
}

async function markStopped(
  execRef: FirebaseFirestore.DocumentReference,
  reason: StoppedReason,
): Promise<void> {
  await execRef.update({
    status: "stopped",
    stoppedReason: reason,
    completedAt: FieldValue.serverTimestamp(),
  });
}

async function markFailed(
  execRef: FirebaseFirestore.DocumentReference,
  reason: StoppedReason,
  errorMessage: string,
): Promise<void> {
  await execRef.update({
    status: "failed",
    stoppedReason: reason,
    completedAt: FieldValue.serverTimestamp(),
  });
  console.error(`[executor] execution ${execRef.id} failed: ${errorMessage}`);
}

async function recordSkip(
  execRef: FirebaseFirestore.DocumentReference,
  contactId: string,
  automation: AutomationDoc,
  stepIndex: number,
  step: PlannedStep,
  opts: { skippedReason?: "opt_out" | "missing_field"; success?: boolean; error?: string },
): Promise<void> {
  const entry: ExecutionStepHistoryEntry = {
    stepIndex,
    channel: step.channel,
    templateId: step.templateId,
    recipient: "",
    // Timestamp.now() not serverTimestamp() — array elements can't carry
    // the top-level-only serverTimestamp() sentinel.
    sentAt: Timestamp.now(),
    success: opts.success ?? false,
    error: opts.error ?? null,
    skippedReason: opts.skippedReason ?? null,
  };
  await execRef.update({
    history: FieldValue.arrayUnion(entry),
    currentStepIndex: stepIndex + 1,
  });
  await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .add({
      type: "automation_step_skipped",
      content: `Skipped step ${stepIndex + 1} of "${automation.name}" (${opts.skippedReason ?? opts.error ?? "unknown"}).`,
      createdBy: "automation",
      meta: {
        automationId: automation.id,
        stepIndex,
        skippedReason: opts.skippedReason ?? null,
      },
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) => console.warn("[executor] skip activity write failed", err));
}

async function writeStepActivity(
  contactId: string,
  automation: AutomationDoc,
  entry: ExecutionStepHistoryEntry,
  success: boolean,
  templateName: string,
): Promise<void> {
  const channel = entry.channel === "email" ? "email" : "SMS";
  const content = success
    ? `Sent ${channel} from automation "${automation.name}" using template "${templateName}".`
    : `Failed to send ${channel} from automation "${automation.name}" — ${entry.error ?? "unknown error"}.`;

  await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .add({
      type: success ? "automation_step_sent" : "automation_failed",
      content,
      createdBy: "automation",
      meta: {
        automationId: automation.id,
        stepIndex: entry.stepIndex,
        channel: entry.channel,
        templateId: entry.templateId,
      },
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) =>
      console.warn("[executor] step activity write failed", err),
    );
}

async function loadOwnerSnapshot(
  agency: AgencyDoc | null,
): Promise<{ displayName: string; email: string }> {
  if (!agency) return { displayName: "", email: "" };
  try {
    const snap = await getAdminDb()
      .collection("users")
      .doc(agency.ownerUid)
      .get();
    const data = snap.data();
    return {
      displayName: (data?.displayName as string) ?? "",
      email: (data?.email as string) ?? "",
    };
  } catch {
    return { displayName: "", email: "" };
  }
}

async function resolveRecipient(
  step: PlannedStep,
  contact: Contact,
): Promise<string> {
  if (step.recipient.kind === "static") {
    return step.recipient.address;
  }
  // contact recipient: pick the right field for the channel
  if (step.channel === "email") return contact.email ?? "";
  return contact.phone ?? "";
}

/**
 * Returns 0 if we're inside the send window (or no window is configured)
 * and a positive number of seconds to defer until the next window start
 * otherwise.
 *
 * Approximation: we use Intl.DateTimeFormat to get the wall-clock hour /
 * minute / second in the configured timezone, then compute how far we are
 * from the start of today's window (or tomorrow's if we've already passed
 * end-of-window today). This is correct in normal time; DST transitions
 * may shift the actual delivery by an hour, which we accept for v1.
 */
// Send-window math now lives in the shared @/lib/time/window util so the
// outbound-voice compliance gate reuses the exact same implementation.
function computeSendWindowDeferral(window: SendWindow | null): number {
  return computeWindowDeferralSeconds(window);
}
