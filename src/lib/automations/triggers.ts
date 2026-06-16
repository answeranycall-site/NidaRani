import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishStep, qstashIsConfigured } from "./qstash";
import type {
  AutomationDoc,
  AutomationTriggerType,
  ExecutionDoc,
  InstantResponseConfig,
} from "@/types";

interface FireTriggersInput {
  agencyId: string;
  subAccountId: string;
  triggerType: AutomationTriggerType;
  contactId: string;
  /** Trigger-specific context, e.g. formId on form_submit. */
  context: { formId?: string };
}

/**
 * Find every enabled automation in this sub-account that matches the
 * trigger, create an execution doc per match, and schedule the first step
 * via QStash.
 *
 * Called server-side only (Admin SDK). Failures are logged but never
 * thrown — a downstream automation problem must not break the upstream
 * action that triggered it (form submission, deal move, etc.).
 */
export async function fireTriggers(input: FireTriggersInput): Promise<void> {
  const db = getAdminDb();

  try {
    // Sub-account-level kill switch — operator panic button. Read once
    // before kicking off any executions; if true, log and bail. Doesn't
    // throw because callers (form submit, etc.) shouldn't fail their
    // primary action just because automations are paused.
    const subSnap = await db
      .doc(`subAccounts/${input.subAccountId}`)
      .get();
    if (subSnap.data()?.automationsPaused === true) {
      console.warn(
        `[fireTriggers] sub-account ${input.subAccountId} has automationsPaused=true — skipping all triggers`,
      );
      return;
    }

    const matches = await db
      .collection("automations")
      .where("subAccountId", "==", input.subAccountId)
      .where("enabled", "==", true)
      .where("trigger.type", "==", input.triggerType)
      .get();

    if (matches.empty) return;

    for (const doc of matches.docs) {
      const automation = doc.data() as AutomationDoc;

      // Trigger-specific filters: form_submit must match the formId.
      if (automation.trigger.type === "form_submit") {
        if (
          automation.trigger.formId &&
          automation.trigger.formId !== input.context.formId
        ) {
          continue;
        }
      }

      await startExecution({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        automation,
        contactId: input.contactId,
      });
    }
  } catch (err) {
    console.error("[fireTriggers] failed", err);
  }
}

interface StartExecutionInput {
  agencyId: string;
  subAccountId: string;
  automation: AutomationDoc;
  contactId: string;
}

/**
 * Pick the first step's delay from the recipe config + create the execution
 * doc + schedule the QStash callback. The step executor reads the same
 * config when it lands and decides which channel to actually send.
 */
async function startExecution(input: StartExecutionInput): Promise<void> {
  const db = getAdminDb();
  const { agencyId, subAccountId, automation, contactId } = input;

  const firstStepDelay = computeFirstStepDelay(automation);
  if (firstStepDelay === null) {
    // Recipe has no enabled steps — nothing to schedule.
    return;
  }

  const ref = db.collection("automation_executions").doc();
  const baseExecution: Omit<ExecutionDoc, "id"> = {
    agencyId,
    subAccountId,
    automationId: automation.id,
    contactId,
    status: "running",
    currentStepIndex: 0,
    nextStepDueAt: null,
    qstashMessageId: null,
    history: [],
    startedAt: FieldValue.serverTimestamp() as unknown as null,
    completedAt: null,
    stoppedReason: null,
  };
  await ref.set({ id: ref.id, ...baseExecution });

  if (!qstashIsConfigured()) {
    console.warn(
      "[fireTriggers] QStash not configured — execution created but no callback scheduled. Configure QSTASH_TOKEN + signing keys to enable sending.",
    );
    await ref.update({ status: "failed", stoppedReason: "automation_disabled" });
    return;
  }

  const result = await publishStep({
    executionId: ref.id,
    stepIndex: 0,
    delaySeconds: firstStepDelay,
  });

  if (!result) {
    await ref.update({ status: "failed", stoppedReason: "automation_disabled" });
    return;
  }

  await ref.update({ qstashMessageId: result.messageId });

  // Activity log: started.
  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "automation_started",
        content: `Automation "${automation.name}" started.`,
        createdBy: "automation",
        meta: { automationId: automation.id, executionId: ref.id },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[fireTriggers] activity write failed", err);
  }
}

/**
 * For Recipe 1, the first step's delay is whichever of leadSms / leadEmail
 * has the shortest configured delay (and is non-null). Recipes 2/4/5 will
 * extend this when they land.
 */
function computeFirstStepDelay(automation: AutomationDoc): number | null {
  switch (automation.recipeType) {
    case "instant_response":
      return firstInstantResponseDelay(automation.config);
    default:
      return null;
  }
}

function firstInstantResponseDelay(
  config: InstantResponseConfig,
): number | null {
  const candidates: number[] = [];
  if (config.leadSms) candidates.push(Math.max(0, config.leadSms.delaySeconds));
  if (config.leadEmail)
    candidates.push(Math.max(0, config.leadEmail.delaySeconds));
  if (config.ownerNotify) candidates.push(0);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
