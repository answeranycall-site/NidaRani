import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendEmail, emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import {
  sendSmsForSubAccount,
  sendWhatsappTemplateForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  subAccountWhatsappIsConfigured,
} from "@/lib/comms/twilio";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { resolveTemplateVariables } from "@/lib/comms/whatsapp/resolve-template-variables";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import {
  resolveMergeTags,
  type MergeTagSubject,
} from "@/lib/automations/merge-tags";
import { buildUnsubscribeUrl } from "@/lib/automations/unsubscribe-token";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { reserveTags } from "@/lib/contacts/tag-registry";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import { RATING_REPLY_WINDOW_MS } from "@/lib/reviews/constants";
import { evalConditionGroup } from "./conditions";
import type { Contact } from "@/types/contacts";
import type { AgencyDoc, SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import type {
  CreateTaskConfig,
  IfElseConfig,
  MoveStageConfig,
  NotifyConfig,
  NotifyOwnerSmsConfig,
  SendEmailConfig,
  SendSmsConfig,
  TagConfig,
  WhatsappTemplateConfig,
  UpdateFieldConfig,
  WaitConfig,
  WebhookConfig,
  WorkflowDoc,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRunDoc,
  WorkflowRunHistoryEntry,
  WorkflowTriggerType,
} from "@/types/workflows";

const STEP_PATH = "/api/workflows/step";

/* --------------------------- Node executors ---------------------------- */

export type StepResult =
  | { kind: "next" }
  | { kind: "wait"; seconds: number }
  | { kind: "branch"; value: boolean }
  | { kind: "end" };

interface NodeContext {
  node: WorkflowNode;
  contact: Contact;
  subAccount: SubAccountDoc | null;
  owner: { displayName: string; email: string };
  subAccountId: string;
  agencyId: string;
  /** Workflow author — stamped on writes (tasks) for audit. */
  createdByUid: string;
  /**
   * The trigger context captured at enrollment (e.g. the submitted form's
   * answers under `formData`), MERGED with anything a later external event
   * stashed on the run (e.g. `reviewOutcome` from `resumeReviewRatingRun`).
   * Carried on the run doc; surfaced here so the Webhook step can forward the
   * form fields downstream, and `notify_owner_sms` can reference the outcome.
   */
  triggerContext: Record<string, unknown>;
  /** The run's own id — needed by nodes that pause and get resumed by an
   *  external event (e.g. `review_rating_request`) to correlate the resume. */
  runId: string;
}

/** An executor returns the control-flow result + a short audit log string. */
type NodeExecutor = (
  ctx: NodeContext
) => Promise<{ result: StepResult; log: string }>;

function mergeSubject(
  ctx: NodeContext,
  unsubscribeLink: string
): MergeTagSubject {
  return {
    contact: {
      name: ctx.contact.name,
      email: ctx.contact.email,
      phone: ctx.contact.phone,
    },
    owner: ctx.owner,
    workspace: { name: ctx.subAccount?.name ?? "" },
    bookingLink: ctx.subAccount?.bookingLink ?? "",
    unsubscribeLink,
  };
}

const execSendEmail: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendEmailConfig;
  const contact = ctx.contact;
  if (contact.emailOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.email;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_email" };
  if (!emailIsConfigured()) {
    return { result: { kind: "next" }, log: "error:email_not_configured" };
  }

  const unsubscribeLink = buildUnsubscribeUrl(contact.id);
  const subject = resolveMergeTags(
    cfg.subject ?? "",
    mergeSubject(ctx, unsubscribeLink)
  );
  const text = resolveMergeTags(
    cfg.body ?? "",
    mergeSubject(ctx, unsubscribeLink)
  );
  const htmlInner = resolveMergeTags(
    cfg.body ?? "",
    mergeSubject(ctx, `<a href="${unsubscribeLink}">Unsubscribe</a>`)
  ).replace(/\r?\n/g, "<br>");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;

  try {
    await sendEmail({
      to,
      subject: subject || "(no subject)",
      text,
      html,
      replyTo: ctx.subAccount?.replyToEmail ?? undefined,
      from: tenantFrom(ctx.subAccount),
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execSendSms: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendSmsConfig;
  const contact = ctx.contact;
  if (contact.smsOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  // Send via the sub-account's dedicated Twilio when configured, else the
  // shared env creds — same resolution the contact-profile SMS uses. The shared
  // fallback only counts when the agency still permits it.
  const hasSms =
    subAccountTwilioIsConfigured(ctx.subAccount?.twilioConfig) ||
    (smsIsConfigured() &&
      (await agencyAllowsSharedSms(ctx.subAccount?.agencyId)));
  if (!hasSms) {
    return { result: { kind: "next" }, log: "error:sms_not_configured" };
  }
  const body = resolveMergeTags(cfg.body ?? "", mergeSubject(ctx, ""));
  try {
    await sendSmsForSubAccount({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      body,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execWhatsappTemplate: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as WhatsappTemplateConfig;
  const contact = ctx.contact;
  if (contact.whatsappOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  // Requires the agency WhatsApp gate AND a configured WhatsApp sender. The
  // builder surfaces this as a red node, but re-check here in case the gate
  // flipped off after the workflow was built.
  if (
    ctx.subAccount?.whatsappEnabledByAgency !== true ||
    !subAccountWhatsappIsConfigured(ctx.subAccount?.twilioConfig)
  ) {
    return { result: { kind: "next" }, log: "error:whatsapp_not_configured" };
  }
  if (!cfg.templateId)
    return { result: { kind: "next" }, log: "skipped:no_template" };

  const tplSnap = await getAdminDb()
    .doc(`subAccounts/${ctx.subAccountId}/whatsappTemplates/${cfg.templateId}`)
    .get();
  const tpl = tplSnap.exists ? (tplSnap.data() as WhatsappTemplateDoc) : null;
  if (!tpl || tpl.status !== "approved" || !tpl.contentSid) {
    // Template was deleted, never approved, or lost approval (paused/disabled).
    return { result: { kind: "next" }, log: "error:template_not_approved" };
  }

  const subject = mergeSubject(ctx, "");
  // Operator-set MANUAL variable values may contain merge tags — resolve them
  // against the contact before handing to the positional resolver.
  const manualValues: Record<number, string> = {};
  for (const [pos, val] of Object.entries(cfg.manualValues ?? {})) {
    manualValues[Number(pos)] = resolveMergeTags(val ?? "", subject);
  }
  const contentVariables = resolveTemplateVariables({
    variables: tpl.variables,
    subject,
    manualValues,
  });

  try {
    await sendWhatsappTemplateForSubAccount({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      contentSid: tpl.contentSid,
      contentVariables,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execWait: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as WaitConfig;
  const seconds = Math.max(0, Math.floor(cfg.seconds ?? 0));
  return { result: { kind: "wait", seconds }, log: `wait:${seconds}s` };
};

const execIfElse: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as IfElseConfig;
  const pass = evalConditionGroup(cfg.conditions, ctx.contact);
  return { result: { kind: "branch", value: pass }, log: `branch:${pass}` };
};

const execGoal: NodeExecutor = async () => ({
  result: { kind: "end" },
  log: "goal",
});

const execAddTag: NodeExecutor = async (ctx) => {
  const tag = ((ctx.node.config as unknown as TagConfig).tag ?? "").trim();
  if (!tag) return { result: { kind: "next" }, log: "skipped:no_tag" };
  // Cap distinct tag values per sub-account (MAX_TAGS_PER_SUBACCOUNT) — an
  // already-registered tag is always free; a brand-new one only goes
  // through while there's room. Blocked = fail soft, skip this node rather
  // than fail the whole run.
  const { allowed } = await reserveTags(ctx.subAccountId, [tag]);
  if (allowed.length === 0) {
    return { result: { kind: "next" }, log: `skipped:tag_cap_reached:${tag}` };
  }
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      tags: FieldValue.arrayUnion(tag),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `tag+:${tag}` };
};

const execRemoveTag: NodeExecutor = async (ctx) => {
  const tag = ((ctx.node.config as unknown as TagConfig).tag ?? "").trim();
  if (!tag) return { result: { kind: "next" }, log: "skipped:no_tag" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      tags: FieldValue.arrayRemove(tag),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `tag-:${tag}` };
};

const execMoveStage: NodeExecutor = async (ctx) => {
  const stage = (
    (ctx.node.config as unknown as MoveStageConfig).stage ?? ""
  ).trim();
  if (!stage) return { result: { kind: "next" }, log: "skipped:no_stage" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({ pipelineStage: stage, updatedAt: FieldValue.serverTimestamp() });
  return { result: { kind: "next" }, log: `stage:${stage}` };
};

// Only these top-level contact fields may be set by a workflow — prevents a
// crafted config from clobbering tenancy/system keys. customFields.* is open.
const WRITABLE_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "company",
  "source",
  "pipelineStage",
]);

const execUpdateField: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as UpdateFieldConfig;
  const field = (cfg.field ?? "").trim();
  if (!field) return { result: { kind: "next" }, log: "skipped:no_field" };
  if (!field.startsWith("customFields.") && !WRITABLE_FIELDS.has(field)) {
    return { result: { kind: "next" }, log: "skipped:field_not_writable" };
  }
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      [field]: cfg.value ?? "",
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `field:${field}` };
};

const execCreateTask: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as CreateTaskConfig;
  const title =
    resolveMergeTags(cfg.title ?? "Follow up", mergeSubject(ctx, "")) ||
    "Follow up";
  const dueAt =
    cfg.dueInDays && cfg.dueInDays > 0
      ? new Date(Date.now() + cfg.dueInDays * 86_400_000)
      : null;
  await createTaskServerSide({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    createdByUid: ctx.createdByUid,
    mode: "live",
    title,
    notes: "Created by workflow",
    dueAt,
    contactId: ctx.contact.id,
    dealId: null,
    eventId: null,
  });
  return { result: { kind: "next" }, log: "task_created" };
};

/**
 * Resolve who an Internal notification emails. "account_contact" reads the
 * sub-account's primary contact (Settings → Admin → Account contact); a custom
 * email is used as typed. The agency owner is the ultimate fallback so a
 * notification is never silently dropped — including when "account_contact" is
 * chosen but that contact has no email set.
 */
function resolveNotifyTo(cfg: NotifyConfig, ctx: NodeContext): string {
  const owner = ctx.owner.email;
  switch (cfg.recipient) {
    case "owner":
      return owner;
    case "account_contact":
      return ctx.subAccount?.accountContact?.email?.trim() || owner;
    // "custom" and legacy (undefined) both use the typed email, else owner.
    default:
      return (cfg.to ?? "").trim() || owner;
  }
}

const execNotify: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as NotifyConfig;
  const to = resolveNotifyTo(cfg, ctx);
  if (!to) return { result: { kind: "next" }, log: "skipped:no_recipient" };
  if (!emailIsConfigured()) {
    return { result: { kind: "next" }, log: "error:email_not_configured" };
  }
  const subject = resolveMergeTags(
    cfg.subject ?? "Workflow notification",
    mergeSubject(ctx, "")
  );
  const text = resolveMergeTags(cfg.body ?? "", mergeSubject(ctx, ""));
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${text.replace(
    /\r?\n/g,
    "<br>"
  )}</body></html>`;
  try {
    await sendEmail({
      to,
      subject: subject || "Workflow notification",
      text,
      html,
      from: tenantFrom(ctx.subAccount),
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

/**
 * Outcome stashed on `run.context.reviewOutcome` by `resumeReviewRatingRun`
 * once a `review_rating_request` node's reply resolves. Absent means either
 * no such node precedes this one, or the 7-day window lapsed with no reply.
 */
interface ReviewOutcome {
  rating: number;
  positive: boolean;
}

function resolveReviewTokens(body: string, ctx: NodeContext): string {
  const outcome = ctx.triggerContext?.reviewOutcome as
    | ReviewOutcome
    | undefined;
  const reviewRating = outcome ? String(outcome.rating) : "";
  const reviewOutcome = outcome
    ? outcome.positive
      ? "positive — sent the Google review link"
      : "negative — flagged internally, not sent to Google"
    : "no reply yet (or no rating request on this workflow)";
  return body
    .replace(/\{\{\s*reviewRating\s*\}\}/g, reviewRating)
    .replace(/\{\{\s*reviewOutcome\s*\}\}/g, reviewOutcome);
}

const execNotifyOwnerSms: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as NotifyOwnerSmsConfig;
  const to = ctx.subAccount?.accountContact?.phone?.trim();
  if (!to) return { result: { kind: "next" }, log: "skipped:no_owner_phone" };
  const body = resolveReviewTokens((cfg.body ?? "").trim(), ctx);
  if (!body) return { result: { kind: "next" }, log: "skipped:no_body" };
  // Same resolution send_sms uses — dedicated Twilio when configured, else
  // the shared env creds if the agency still permits it.
  const hasSms =
    subAccountTwilioIsConfigured(ctx.subAccount?.twilioConfig) ||
    (smsIsConfigured() &&
      (await agencyAllowsSharedSms(ctx.subAccount?.agencyId)));
  if (!hasSms) {
    return { result: { kind: "next" }, log: "error:sms_not_configured" };
  }
  try {
    await sendSmsForSubAccount({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      body,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

/**
 * Shared "send the ask + notify the owner + arm the wait" logic used by
 * both `review_rating_request` (the first ask) and `review_rating_reminder`
 * (the one-time follow-up if 7 days pass with no reply) — the two only
 * differ in the review-request trigger value and the owner-notify wording.
 * Correlates the contact's next inbound reply back to THIS run so
 * lib/reviews/rating-reply.ts can resume it the moment they answer,
 * instead of waiting out the full 7-day timeout.
 */
async function sendRatingAskAndArmWait(
  ctx: NodeContext,
  trigger: "workflow" | "reminder",
  ownerNotifyBody: (identity: string) => string
): Promise<{ result: StepResult; log: string }> {
  const contact = ctx.contact;
  if (contact.smsOptedOut) {
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  }
  if (!contact.phone) {
    return { result: { kind: "next" }, log: "skipped:no_phone" };
  }
  if (!ctx.subAccount?.googleReviewConfig?.reviewUrl) {
    return {
      result: { kind: "next" },
      log: "error:review_url_not_configured",
    };
  }
  if (!subAccountTwilioIsConfigured(ctx.subAccount?.twilioConfig)) {
    return { result: { kind: "next" }, log: "error:dedicated_twilio_required" };
  }

  const res = await maybeSendReviewRequest({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    contactId: contact.id,
    trigger,
  });
  if (!res.sent) {
    return { result: { kind: "next" }, log: `skipped:${res.reason ?? "not_sent"}` };
  }

  // Let the owner know — separate from (and ahead of) the eventual outcome
  // notification a downstream `notify_owner_sms` step sends once the
  // reply resolves. Best-effort; a failure here can't undo the send.
  const ownerPhone = ctx.subAccount?.accountContact?.phone?.trim();
  if (ownerPhone) {
    const identity = contact.name
      ? `${contact.name} (${contact.phone})`
      : contact.phone;
    try {
      await sendSmsForSubAccount({
        subAccountId: ctx.subAccountId,
        subAccount: ctx.subAccount,
        to: ownerPhone,
        body: ownerNotifyBody(identity),
      });
    } catch (err) {
      console.warn(`[workflows] review-rating ask owner-notify failed (trigger=${trigger})`, err);
    }
  }

  await getAdminDb()
    .doc(`contacts/${contact.id}`)
    .set(
      {
        pendingReviewWorkflowRunId: ctx.runId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  return {
    result: { kind: "wait", seconds: Math.floor(RATING_REPLY_WINDOW_MS / 1000) },
    log: trigger === "reminder" ? "ok:reminder_sent" : "ok:awaiting_rating",
  };
}

/**
 * Sends the "how many stars" ask (reusing the sub-account's Settings →
 * Messaging → Review requests config for the review URL + templates),
 * texts the business owner that a request just went out, and pauses the
 * run — see ReviewRatingRequestConfig's doc comment for the full picture.
 * Resumed early by `resumeReviewRatingRun` when the customer replies, or
 * by its own long `wait` as a 7-day timeout fallback otherwise.
 */
const execReviewRatingRequest: NodeExecutor = (ctx) =>
  sendRatingAskAndArmWait(
    ctx,
    "workflow",
    (identity) => `A review request was sent to ${identity}.`
  );

/**
 * One-time follow-up for `review_rating_request`'s 7-day no-reply timeout
 * — texts the owner that the window lapsed with no response, resends the
 * SAME ask to the contact (bypassing the normal cooldown — this is an
 * explicit, one-off reminder, not a repeat auto-send), texts the owner
 * that the reminder went out, and re-arms another 7-day wait so a reply to
 * the reminder is caught the same way the first ask's would be.
 *
 * A transparent passthrough when the contact already replied to the first
 * ask (`ctx.triggerContext.reviewOutcome` is set) — safe to place
 * unconditionally right after `review_rating_request` in every workflow
 * that uses it, regardless of how the first ask resolved.
 */
const execReviewRatingReminder: NodeExecutor = async (ctx) => {
  if (ctx.triggerContext?.reviewOutcome) {
    return { result: { kind: "next" }, log: "skipped:already_replied" };
  }
  // The preceding review_rating_request node only ever WAITS (pausing the
  // run) when it actually sent the ask — every skip path (cooldown,
  // opted-out, no phone, missing config) returns "next" instead, meaning
  // this node runs again immediately with `reviewOutcome` absent. Without
  // this check that reads as "no reply after 7 days" even though nothing
  // was ever sent. `awaitingReviewReplyAt` is ONLY stamped when the ask
  // genuinely went out, so its absence reliably means "there was no ask to
  // follow up on" — pass through silently rather than notifying the owner
  // of a false timeout and sending a stray "reminder".
  if (!ctx.contact.awaitingReviewReplyAt) {
    return { result: { kind: "next" }, log: "skipped:no_original_ask" };
  }

  const contact = ctx.contact;
  const identity = contact.name
    ? `${contact.name} (${contact.phone})`
    : contact.phone;
  const ownerPhone = ctx.subAccount?.accountContact?.phone?.trim();
  if (ownerPhone) {
    try {
      await sendSmsForSubAccount({
        subAccountId: ctx.subAccountId,
        subAccount: ctx.subAccount,
        to: ownerPhone,
        body: `It's been 7 days since we asked ${identity} to rate their experience, and they haven't responded.`,
      });
    } catch (err) {
      console.warn("[workflows] review_rating_reminder timeout owner-notify failed", err);
    }
  }

  return sendRatingAskAndArmWait(
    ctx,
    "reminder",
    (id) => `We just sent ${id} a reminder to rate their experience.`
  );
};

const execWebhook: NodeExecutor = async (ctx) => {
  const url = ((ctx.node.config as unknown as WebhookConfig).url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { result: { kind: "next" }, log: "skipped:bad_url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  // The submitted form's answers (label → value), captured at enrollment.
  // Empty {} for triggers that don't carry a form (e.g. pipeline change, test).
  const tc = ctx.triggerContext ?? {};
  const formData =
    tc.formData && typeof tc.formData === "object"
      ? (tc.formData as Record<string, unknown>)
      : {};
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "workflow.webhook",
        contact: {
          id: ctx.contact.id,
          name: ctx.contact.name,
          email: ctx.contact.email,
          phone: ctx.contact.phone,
        },
        form: {
          id: typeof tc.formId === "string" ? tc.formId : null,
          name: typeof tc.formName === "string" ? tc.formName : null,
          fields: formData,
        },
      }),
      signal: controller.signal,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "webhook_failed"}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Unimplemented node types pass through (no stall) until their slice lands. */
const execPassThrough: NodeExecutor = async () => ({
  result: { kind: "next" },
  log: "unsupported_passthrough",
});

const REGISTRY: Partial<Record<WorkflowNodeType, NodeExecutor>> = {
  send_email: execSendEmail,
  send_sms: execSendSms,
  whatsapp_template: execWhatsappTemplate,
  wait: execWait,
  if_else: execIfElse,
  goal: execGoal,
  add_tag: execAddTag,
  remove_tag: execRemoveTag,
  move_stage: execMoveStage,
  update_field: execUpdateField,
  create_task: execCreateTask,
  notify: execNotify,
  notify_owner_sms: execNotifyOwnerSms,
  review_rating_request: execReviewRatingRequest,
  review_rating_reminder: execReviewRatingReminder,
  webhook: execWebhook,
};

/* ----------------------------- Dispatch -------------------------------- */

interface FireInput {
  subAccountId: string;
  agencyId: string;
  type: WorkflowTriggerType;
  contactId: string;
  context?: Record<string, unknown>;
}

/**
 * Find every ACTIVE workflow matching the trigger + filters and enroll the
 * contact. Server-only; never throws — a workflow problem must not break the
 * action that triggered it.
 */
export async function fireWorkflowTrigger(input: FireInput): Promise<void> {
  const db = getAdminDb();
  try {
    const subSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
    if (subSnap.data()?.automationsPaused === true) return;

    const matches = await db
      .collection("workflows")
      .where("subAccountId", "==", input.subAccountId)
      .where("status", "==", "active")
      .where("trigger.type", "==", input.type)
      .get();
    if (matches.empty) return;

    const contactSnap = await db.doc(`contacts/${input.contactId}`).get();
    if (!contactSnap.exists) return;
    const contact = {
      id: contactSnap.id,
      ...(contactSnap.data() as Omit<Contact, "id">),
    };

    for (const doc of matches.docs) {
      const wf = { id: doc.id, ...(doc.data() as Omit<WorkflowDoc, "id">) };
      if (!wf.startNodeId) continue;

      // Trigger-specific narrowing.
      if (
        wf.trigger.type === "form.submitted" &&
        wf.trigger.formId &&
        wf.trigger.formId !== input.context?.formId
      ) {
        continue;
      }
      if (
        wf.trigger.type === "pipeline.stage.changed" &&
        wf.trigger.toStage &&
        wf.trigger.toStage !== input.context?.toStage
      ) {
        continue;
      }
      if (!evalConditionGroup(wf.trigger.filters, contact)) continue;

      await enroll(wf, contact.id, input.context ?? {});
    }
  } catch (err) {
    console.error("[workflows] fireWorkflowTrigger failed", err);
  }
}

async function enroll(
  wf: WorkflowDoc,
  contactId: string,
  context: Record<string, unknown>
): Promise<void> {
  const db = getAdminDb();
  const runRef = db.collection("workflowRuns").doc();
  await runRef.set({
    id: runRef.id,
    subAccountId: wf.subAccountId,
    agencyId: wf.agencyId,
    workflowId: wf.id,
    contactId,
    status: "running",
    currentNodeId: wf.startNodeId,
    history: [],
    context,
    qstashMessageId: null,
    enrolledAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db
    .doc(`workflows/${wf.id}`)
    .update({ "stats.enrolled": FieldValue.increment(1) })
    .catch(() => {});

  if (!qstashIsConfigured()) {
    await runRef.update({ status: "failed" });
    return;
  }
  await scheduleNode(runRef, wf.startNodeId!, 0);
}

/* ------------------------------ Run worker ----------------------------- */

async function scheduleNode(
  runRef: FirebaseFirestore.DocumentReference,
  nodeId: string,
  delaySeconds: number
): Promise<void> {
  const res = await publishCallback({
    pathname: STEP_PATH,
    body: { runId: runRef.id, nodeId },
    delaySeconds,
    deduplicationId: `wf_${runRef.id}_${nodeId}`,
  });
  if (!res) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  await runRef.update({
    currentNodeId: nodeId,
    status: delaySeconds > 0 ? "waiting" : "running",
    qstashMessageId: res.messageId,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function completeRun(
  runRef: FirebaseFirestore.DocumentReference,
  workflowId: string
): Promise<void> {
  await runRef.update({
    status: "completed",
    currentNodeId: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await getAdminDb()
    .doc(`workflows/${workflowId}`)
    .update({ "stats.completed": FieldValue.increment(1) })
    .catch(() => {});
}

/** Advance one node of a run. Idempotent on the run's history. */
export async function runStep(runId: string, nodeId: string): Promise<void> {
  const db = getAdminDb();
  const runRef = db.collection("workflowRuns").doc(runId);
  const runSnap = await runRef.get();
  if (!runSnap.exists) return;
  const run = runSnap.data() as WorkflowRunDoc;

  if (run.status !== "running" && run.status !== "waiting") return;
  if (run.history.some((h) => h.nodeId === nodeId)) return; // QStash retry

  const wfSnap = await db.doc(`workflows/${run.workflowId}`).get();
  if (!wfSnap.exists) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  const wf = wfSnap.data() as WorkflowDoc;
  // Test runs execute regardless of status so a draft can be dry-run; real
  // enrollments require the workflow to still be active.
  if (wf.status !== "active" && run.context?.test !== true) {
    await runRef.update({
      status: "exited",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const node = wf.nodes[nodeId];
  if (!node) {
    await completeRun(runRef, wf.id);
    return;
  }

  const contactSnap = await db.doc(`contacts/${run.contactId}`).get();
  if (!contactSnap.exists) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };

  const [subSnap, agencySnap] = await Promise.all([
    db.doc(`subAccounts/${run.subAccountId}`).get(),
    db.doc(`agencies/${run.agencyId}`).get(),
  ]);
  const subAccount = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

  if (subAccount?.automationsPaused === true) {
    await runRef.update({
      status: "exited",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const owner = await loadOwner(agency);
  const exec = REGISTRY[node.type] ?? execPassThrough;
  const { result, log } = await exec({
    node,
    contact,
    subAccount,
    owner,
    subAccountId: run.subAccountId,
    agencyId: run.agencyId,
    createdByUid: wf.createdByUid,
    triggerContext: run.context ?? {},
    runId,
  });

  const entry: WorkflowRunHistoryEntry = {
    nodeId,
    type: node.type,
    at: Timestamp.now(),
    result: log,
  };
  await runRef.update({
    history: FieldValue.arrayUnion(entry),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Advance control flow.
  let target: string | null = null;
  let delay = 0;
  if (result.kind === "end") {
    await completeRun(runRef, wf.id);
    return;
  } else if (result.kind === "branch") {
    const b = node.branches;
    target = (result.value ? b?.whenTrue : b?.whenFalse) ?? null;
  } else if (result.kind === "wait") {
    target = node.next ?? null;
    delay = result.seconds;
  } else {
    target = node.next ?? null;
  }

  if (!target) {
    await completeRun(runRef, wf.id);
    return;
  }
  await scheduleNode(runRef, target, delay);
}

/**
 * Resume a run paused by `review_rating_request` as soon as the customer's
 * rating reply resolves — called from lib/reviews/rating-reply.ts right after
 * it determines the 1-5 rating, instead of leaving the run to its own 7-day
 * timeout fallback. Stashes the outcome on `run.context.reviewOutcome` (read
 * by `notify_owner_sms` via the `{{reviewRating}}` / `{{reviewOutcome}}`
 * tokens) then advances the run one step immediately.
 *
 * Safe against the timeout racing in later: `runStep`'s own guards (run
 * status must still be "running"/"waiting"; a nodeId already in `history` is
 * a no-op) mean whichever of the two — this early resume, or the QStash
 * timeout firing 7 days out — arrives first "wins"; the other becomes a
 * harmless no-op. Never throws — a workflow problem can't break the
 * customer-facing rating reply that triggered this.
 */
export async function resumeReviewRatingRun(
  runId: string,
  outcome: { rating: number; positive: boolean }
): Promise<void> {
  try {
    const db = getAdminDb();
    const runRef = db.collection("workflowRuns").doc(runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return;
    const run = runSnap.data() as WorkflowRunDoc;
    if (run.status !== "waiting" || !run.currentNodeId) return;

    await runRef.update({
      context: { ...(run.context ?? {}), reviewOutcome: outcome },
      updatedAt: FieldValue.serverTimestamp(),
    });
    await runStep(runId, run.currentNodeId);
  } catch (err) {
    console.error("[workflows] resumeReviewRatingRun failed", err);
  }
}

/** Manually enroll one contact to dry-run a workflow (ignores trigger/filters;
 *  runs even on a draft via the `test` context flag). */
export async function enrollForTest(opts: {
  subAccountId: string;
  workflowId: string;
  contactId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const db = getAdminDb();
  const wfSnap = await db.doc(`workflows/${opts.workflowId}`).get();
  if (!wfSnap.exists) return { ok: false, error: "Workflow not found" };
  const wf = { id: wfSnap.id, ...(wfSnap.data() as Omit<WorkflowDoc, "id">) };
  if (wf.subAccountId !== opts.subAccountId) {
    return { ok: false, error: "Workflow not found" };
  }
  if (!wf.startNodeId)
    return { ok: false, error: "Add at least one step first" };
  const cSnap = await db.doc(`contacts/${opts.contactId}`).get();
  if (!cSnap.exists || cSnap.data()!.subAccountId !== opts.subAccountId) {
    return { ok: false, error: "Contact not found" };
  }

  // A prior test's rating-gate state (hold, cooldown stamp, etc.) would
  // otherwise carry over and make review_rating_request/_reminder behave
  // as if the contact already had a request pending — clear it so every
  // Test click starts the gate fresh. Only touches these specific fields;
  // never runs for a real (non-test) enrollment.
  const hasReviewNode = Object.values(wf.nodes).some(
    (n) => n.type === "review_rating_request" || n.type === "review_rating_reminder"
  );
  if (hasReviewNode) {
    await cSnap.ref.set(
      {
        awaitingReviewReplyAt: FieldValue.delete(),
        awaitingReviewReplyAttempts: FieldValue.delete(),
        pendingRatingHoldValue: FieldValue.delete(),
        pendingRatingHoldMessage: FieldValue.delete(),
        pendingRatingConfirm: FieldValue.delete(),
        pendingReviewWorkflowRunId: FieldValue.delete(),
        reviewRequestedAt: FieldValue.delete(),
        lastReviewRating: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  await enroll(wf, opts.contactId, { test: true });
  return { ok: true };
}

async function loadOwner(
  agency: AgencyDoc | null
): Promise<{ displayName: string; email: string }> {
  if (!agency?.ownerUid) return { displayName: "", email: "" };
  try {
    const snap = await getAdminDb().doc(`users/${agency.ownerUid}`).get();
    const d = snap.data();
    return {
      displayName: (d?.displayName as string) ?? "",
      email: (d?.email as string) ?? "",
    };
  } catch {
    return { displayName: "", email: "" };
  }
}
