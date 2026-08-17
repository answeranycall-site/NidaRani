import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { smsIsConfigured, subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { enqueuePooledSms } from "@/lib/comms/sms-pool";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { recordSend } from "@/lib/comms/usage";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resumeWorkflowRunAfterApproval } from "@/lib/workflows/engine";
import type { SubAccountDoc } from "@/types";
import type { ConversationDraft } from "@/types/conversations";

type Body = { contactId?: string; body?: string };

/**
 * Send an SMS from a contact profile.
 *
 * Mode selection now happens inside `enqueuePooledSms` (`lib/comms/sms-
 * pool.ts`):
 *   - A number-pool sub-account resolves which of its numbers this
 *     CONTACT is assigned to (or blocks with a clear error if that number
 *     was disabled — see `resolvePoolFromNumber`), reserves a rate-limited
 *     send slot, and either delivers inline (the common case) or defers to
 *     a QStash callback — in which case message-row/activity/conversation
 *     bookkeeping happens later, not in this request.
 *   - Every other sub-account (dedicated single-number or shared-env) sends
 *     exactly as before — this route still owns the bookkeeping for that
 *     case, unchanged from before the number-pool feature existed.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  const body = payload.body?.trim();

  if (!contactId || !body) {
    return NextResponse.json(
      { error: "contactId and body are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  if (!contact.phone) {
    return NextResponse.json(
      { error: "This contact has no phone number." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subAccountSnap = await db
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;

  // If this send is approving an AI Booking + Nurture draft, capture the
  // paused workflow run's id BEFORE sending so it can be resumed once the
  // send lands.
  const convoSnap = await db.doc(`conversations/${contactId}`).get();
  const pendingDraft = convoSnap.data()?.pendingDraft as
    | ConversationDraft
    | undefined;
  const draftWorkflowRunId = pendingDraft?.workflowRunId ?? null;

  const dedicated = subAccountTwilioIsConfigured(subAccount?.twilioConfig);
  const pooled = subAccount?.twilioConfig?.numberPoolEnabled === true;
  if (!dedicated && !pooled && !smsIsConfigured()) {
    return NextResponse.json(
      { error: "SMS is not configured on this deployment." },
      { status: 503 },
    );
  }

  const result = await enqueuePooledSms({
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    subAccount: subAccount ?? ({ twilioConfig: null } as SubAccountDoc),
    contact: { id: contactId, assignedFromNumber: contact.assignedFromNumber },
    to: contact.phone,
    body,
    meta: { source: "manual", sentByUid: auth.uid },
  });

  const resumeWorkflowIfNeeded = () => {
    if (draftWorkflowRunId) {
      void resumeWorkflowRunAfterApproval(draftWorkflowRunId, {
        approved: true,
      }).catch((err) => console.warn("[sms/send] workflow resume failed", err));
    }
  };

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 502 });
  }

  // Pooled + deferred: nothing to persist here — the QStash callback does
  // the message-row/activity/conversation bookkeeping once it actually
  // sends. Tell the operator it's queued rather than pretending it's done.
  // The operator's approval is confirmed the moment it's durably queued, so
  // the workflow resume still fires now, independent of delivery timing.
  if (result.pooled && !result.sentInline) {
    resumeWorkflowIfNeeded();
    await recordSend(auth.uid, "sms");
    return NextResponse.json({
      ok: true,
      queued: true,
      delaySeconds: result.delaySeconds,
      from: result.from,
    });
  }

  // Pooled + delivered inline: bookkeeping already done by deliverPooledSms.
  if (result.pooled && result.sentInline) {
    resumeWorkflowIfNeeded();
    await recordSend(auth.uid, "sms");
    return NextResponse.json({ ok: true, sid: result.sid, mode: "dedicated" });
  }

  // Legacy (non-pool) path — this route still owns bookkeeping, unchanged.
  const { sid, from: fromNumber, mode } = result;
  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "sms_sent",
        content: `SMS: ${preview}`,
        createdBy: auth.uid,
        meta: { sid, mode },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[sms/send] activity write failed", err);
  }

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("messages")
      .doc(sid)
      .set({
        agencyId: contact.agencyId,
        subAccountId: contact.subAccountId,
        contactId,
        direction: "outbound",
        status: "sent",
        body,
        from: fromNumber,
        to: contact.phone,
        twilioMessageSid: sid,
        sentByUid: auth.uid,
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[sms/send] message-row write failed", err);
  }

  await upsertConversationForMessage({
    contactId,
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    contactName: contact.name ?? "",
    contactPhone: contact.phone,
    channel: "sms",
    direction: "outbound",
    body,
    pauseBot: true,
  });

  resumeWorkflowIfNeeded();

  await recordSend(auth.uid, "sms");

  return NextResponse.json({ ok: true, sid, mode });
}
