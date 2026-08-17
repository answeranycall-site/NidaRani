import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getTwilioForSubAccount, sendSmsForSubAccount, type TwilioMode } from "@/lib/comms/twilio";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import type { SubAccountDoc, TwilioPoolNumber } from "@/types";

/**
 * Multi-number outbound SMS pool. A sub-account with `twilioConfig.
 * numberPoolEnabled === true` sends from one of several `twilioNumbers`
 * (all sharing the pool's Account SID/Auth Token) instead of the single
 * legacy `twilioConfig.fromNumber` — see `types/tenancy.ts::TwilioPoolNumber`
 * for why this lives in a subcollection rather than an array field.
 *
 * `enqueuePooledSms()` is the entry point every send call site should
 * migrate to. For a non-pool sub-account it's a thin, behavior-identical
 * wrapper around the existing `sendSmsForSubAccount` — the caller still owns
 * message-row/activity/conversation bookkeeping exactly as before (see the
 * `pooled: false` result branch). For a pool sub-account, this module owns
 * the full send-and-persist sequence internally (via `deliverPooledSms`),
 * because a pooled send may not happen synchronously — the caller can't
 * write bookkeeping for a message that hasn't sent yet.
 */

const POOL_SEND_STEP_PATH = "/api/webhooks/sms/pool-send-step";

/** "+15551234567" -> "_15551234567" — usable as both a Firestore doc id and
 *  a QStash deduplication-id segment without escaping. */
export function slugifyE164(e164: string): string {
  return e164.startsWith("+") ? `_${e164.slice(1)}` : e164;
}

/* ------------------------------ Resolution ------------------------------ */

export type PoolResolution =
  | { pooled: false; fromNumber: string }
  | { pooled: true; fromNumber: string; numberDocId: string; ratePerMinute: number }
  | { blocked: true; reason: string };

/**
 * Which number should a send to this contact use? Enforces "block, don't
 * silently reroute" when a contact's assigned number is disabled/removed —
 * see the doc comment on `Contact.assignedFromNumber`.
 */
export function resolvePoolFromNumber(
  subAccount: SubAccountDoc,
  contact: { assignedFromNumber?: string | null } | null | undefined,
  pool: TwilioPoolNumber[],
): PoolResolution {
  const cfg = subAccount.twilioConfig;
  if (!cfg?.numberPoolEnabled || pool.length === 0) {
    if (!cfg?.fromNumber) {
      return { blocked: true, reason: "No Twilio number configured for this sub-account." };
    }
    return { pooled: false, fromNumber: cfg.fromNumber };
  }

  const defaultRate = cfg.defaultRatePerMinutePerNumber ?? 2;
  const enabledPool = pool.filter((n) => n.enabled);

  if (contact?.assignedFromNumber) {
    const assigned = enabledPool.find((n) => n.e164 === contact.assignedFromNumber);
    if (!assigned) {
      return {
        blocked: true,
        reason: `Assigned number ${contact.assignedFromNumber} is disabled or was removed from the pool — reassign this contact to send.`,
      };
    }
    return {
      pooled: true,
      fromNumber: assigned.e164,
      numberDocId: assigned.id,
      ratePerMinute: assigned.ratePerMinuteOverride ?? defaultRate,
    };
  }

  const primary = enabledPool.find((n) => n.isPrimary) ?? enabledPool[0];
  if (!primary) {
    return { blocked: true, reason: "No enabled numbers in the pool." };
  }
  return {
    pooled: true,
    fromNumber: primary.e164,
    numberDocId: primary.id,
    ratePerMinute: primary.ratePerMinuteOverride ?? defaultRate,
  };
}

async function loadEnabledPool(subAccountId: string): Promise<TwilioPoolNumber[]> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/twilioNumbers`)
    .where("enabled", "==", true)
    .get();
  return snap.docs.map((d) => d.data() as TwilioPoolNumber);
}

/* ----------------------------- Rate limiter ------------------------------ */

/**
 * Atomically reserve the next available send slot on one pool number.
 * Every send source (manual, AI, workflow) calls this same function against
 * the same per-number doc, so concurrent sends from different sources
 * correctly serialize — and because the reservation commits to Firestore
 * before any Twilio call happens, it's durable across restarts (nothing is
 * held in server memory).
 */
export async function reserveSendSlot(input: {
  subAccountId: string;
  numberDocId: string;
  ratePerMinute: number;
}): Promise<{ scheduledFor: Date; delaySeconds: number }> {
  const intervalMs = Math.ceil(60_000 / Math.max(1, input.ratePerMinute));
  const ref = getAdminDb().doc(
    `subAccounts/${input.subAccountId}/twilioNumbers/${input.numberDocId}`,
  );
  const scheduledForMs = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const currentNextAvailable =
      (snap.data()?.nextAvailableAt as Timestamp | undefined)?.toMillis?.() ?? 0;
    const mySlot = Math.max(now, currentNextAvailable);
    tx.set(
      ref,
      {
        nextAvailableAt: Timestamp.fromMillis(mySlot + intervalMs),
        cursorUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return mySlot;
  });
  const delaySeconds = Math.max(0, Math.ceil((scheduledForMs - Date.now()) / 1000));
  return { scheduledFor: new Date(scheduledForMs), delaySeconds };
}

/* -------------------------------- Outbox --------------------------------- */

export type SmsOutboxStatus = "queued" | "sending" | "sent" | "failed";

export interface SmsOutboxMeta {
  source: "manual" | "ai_draft" | "workflow" | "system";
  sentByUid?: string | null;
  workflowRunId?: string | null;
  /** True when a "manual" send is actually approving an existing AI draft
   *  (Suggest mode) rather than a genuinely fresh composer message — see
   *  the pauseBot/clearDraft split in conversations-service.ts. Only
   *  meaningful when source === "manual". */
  isDraftApproval?: boolean;
}

interface SmsOutboxDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  contactId: string;
  to: string;
  body: string;
  fromNumber: string;
  status: SmsOutboxStatus;
  meta: SmsOutboxMeta;
  sid: string | null;
  error: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Idempotent delivery of one outbox entry — claims it via a transaction
 * (queued -> sending) so the inline delivery path and a near-simultaneous
 * QStash callback can never both send the same message. Safe to call
 * multiple times; every call after the first is a harmless no-op reporting
 * whatever the first call actually did.
 */
export async function deliverPooledSms(
  subAccountId: string,
  outboxId: string,
  subAccountDoc?: SubAccountDoc | null,
): Promise<{ ok: true; sid: string; from: string } | { ok: false; error: string }> {
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/smsOutbox/${outboxId}`);

  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { claimed: false, data: null };
    const data = snap.data() as SmsOutboxDoc;
    if (data.status !== "queued") return { claimed: false, data };
    tx.set(ref, { status: "sending", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { claimed: true, data };
  });

  if (!claim.data) return { ok: false, error: "Outbox entry not found" };
  if (!claim.claimed) {
    // Already handled by a prior call — report that outcome, don't re-send.
    return claim.data.status === "sent"
      ? { ok: true, sid: claim.data.sid ?? "", from: claim.data.fromNumber }
      : { ok: false, error: claim.data.error ?? "Not queued" };
  }

  const outbox = claim.data;
  let subAccount = subAccountDoc ?? null;
  if (!subAccount) {
    const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    subAccount = (subSnap.data() as SubAccountDoc | undefined) ?? null;
  }

  try {
    const resolved = await getTwilioForSubAccount(subAccountId, subAccount);
    const msg = await resolved.client.messages.create({
      from: outbox.fromNumber,
      to: outbox.to,
      body: outbox.body,
    });

    await ref.set(
      { status: "sent", sid: msg.sid, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    await db
      .collection("contacts")
      .doc(outbox.contactId)
      .collection("messages")
      .doc(msg.sid)
      .set({
        agencyId: outbox.agencyId,
        subAccountId,
        contactId: outbox.contactId,
        direction: "outbound",
        status: "sent",
        body: outbox.body,
        from: outbox.fromNumber,
        to: outbox.to,
        twilioMessageSid: msg.sid,
        sentByUid: outbox.meta?.sentByUid ?? outbox.meta?.source ?? null,
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });

    const preview = outbox.body.length > 80 ? `${outbox.body.slice(0, 80)}…` : outbox.body;
    await db
      .collection("contacts")
      .doc(outbox.contactId)
      .collection("activities")
      .add({
        type: "sms_sent",
        content: `SMS: ${preview}`,
        createdBy: outbox.meta?.sentByUid ?? outbox.meta?.source ?? "sms-pool",
        meta: { sid: msg.sid, mode: "dedicated", pooled: true, fromNumber: outbox.fromNumber },
        createdAt: FieldValue.serverTimestamp(),
      });

    const contactSnap = await db.doc(`contacts/${outbox.contactId}`).get();
    const contactData = contactSnap.data() as { name?: string; phone?: string } | undefined;
    await upsertConversationForMessage({
      contactId: outbox.contactId,
      subAccountId,
      agencyId: outbox.agencyId,
      contactName: contactData?.name ?? "",
      contactPhone: contactData?.phone ?? outbox.to,
      channel: "sms",
      direction: "outbound",
      body: outbox.body,
      pauseBot: outbox.meta?.source === "manual" && !outbox.meta?.isDraftApproval,
      clearDraft: outbox.meta?.source === "manual" && !!outbox.meta?.isDraftApproval,
    });

    return { ok: true, sid: msg.sid, from: outbox.fromNumber };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Send failed";
    await ref
      .set({ status: "failed", error: message, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {});
    return { ok: false, error: message };
  }
}

/* ------------------------------ Orchestrator ----------------------------- */

export interface EnqueuePooledSmsInput {
  subAccountId: string;
  agencyId: string;
  subAccount: SubAccountDoc;
  contact: { id: string; assignedFromNumber?: string | null };
  to: string;
  body: string;
  meta: SmsOutboxMeta;
}

export type EnqueuePooledSmsResult =
  /** Legacy (non-pool) sub-account — caller still owns message-row/activity/
   *  conversation bookkeeping, exactly as every send call site does today. */
  | { ok: true; pooled: false; sid: string; from: string; mode: TwilioMode }
  /** Pooled, delivered synchronously in this same request (the common case —
   *  a lone send rarely contends against the per-number pace). Bookkeeping
   *  already done internally. */
  | { ok: true; pooled: true; sentInline: true; sid: string; from: string }
  /** Pooled, deferred — the per-number pace pushed this send into the
   *  future. A QStash callback will deliver it (and do bookkeeping) later. */
  | { ok: true; pooled: true; sentInline: false; outboxId: string; from: string; delaySeconds: number }
  | { ok: false; blocked: true; reason: string };

export async function enqueuePooledSms(
  input: EnqueuePooledSmsInput,
): Promise<EnqueuePooledSmsResult> {
  const cfg = input.subAccount.twilioConfig;

  if (!cfg?.numberPoolEnabled) {
    try {
      const result = await sendSmsForSubAccount({
        subAccountId: input.subAccountId,
        subAccount: input.subAccount,
        to: input.to,
        body: input.body,
      });
      return { ok: true, pooled: false, sid: result.sid, from: result.from, mode: result.mode };
    } catch (err) {
      return {
        ok: false,
        blocked: true,
        reason: err instanceof Error ? err.message : "Send failed",
      };
    }
  }

  const pool = await loadEnabledPool(input.subAccountId);
  const resolution = resolvePoolFromNumber(input.subAccount, input.contact, pool);
  if ("blocked" in resolution) {
    return { ok: false, blocked: true, reason: resolution.reason };
  }
  if (!resolution.pooled) {
    // numberPoolEnabled was true but resolvePoolFromNumber fell through to
    // the legacy branch (empty pool) — treat identically to the non-pool path.
    try {
      const result = await sendSmsForSubAccount({
        subAccountId: input.subAccountId,
        subAccount: input.subAccount,
        to: input.to,
        body: input.body,
      });
      return { ok: true, pooled: false, sid: result.sid, from: result.from, mode: result.mode };
    } catch (err) {
      return {
        ok: false,
        blocked: true,
        reason: err instanceof Error ? err.message : "Send failed",
      };
    }
  }

  const db = getAdminDb();
  const outboxRef = db.collection(`subAccounts/${input.subAccountId}/smsOutbox`).doc();
  await outboxRef.set({
    id: outboxRef.id,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactId: input.contact.id,
    to: input.to,
    body: input.body,
    fromNumber: resolution.fromNumber,
    status: "queued",
    meta: input.meta,
    sid: null,
    error: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  } satisfies SmsOutboxDoc);

  const { delaySeconds } = await reserveSendSlot({
    subAccountId: input.subAccountId,
    numberDocId: resolution.numberDocId,
    ratePerMinute: resolution.ratePerMinute,
  });

  if (qstashIsConfigured()) {
    // Durability safety net — fires even when delaySeconds is 0, so a
    // process death between the reservation above and the inline delivery
    // below still results in the message eventually sending.
    await publishCallback({
      pathname: POOL_SEND_STEP_PATH,
      body: { outboxId: outboxRef.id, subAccountId: input.subAccountId },
      delaySeconds,
      deduplicationId: `pool_send_${outboxRef.id}`,
    });
  }

  if (delaySeconds === 0) {
    const delivered = await deliverPooledSms(input.subAccountId, outboxRef.id, input.subAccount);
    if (delivered.ok) {
      return { ok: true, pooled: true, sentInline: true, sid: delivered.sid, from: delivered.from };
    }
    return { ok: false, blocked: true, reason: delivered.error };
  }

  return {
    ok: true,
    pooled: true,
    sentInline: false,
    outboxId: outboxRef.id,
    from: resolution.fromNumber,
    delaySeconds,
  };
}
