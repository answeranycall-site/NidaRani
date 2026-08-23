import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { enqueuePooledSms } from "@/lib/comms/sms-pool";
import { resolveMergeTags, type MergeTagSubject } from "@/lib/automations/merge-tags";
import type {
  SmsCampaignDoc,
  SmsCampaignRecipientDoc,
  SmsCampaignSkipReason,
  SubAccountDoc,
} from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

interface StepBody {
  campaignId?: string;
  contactId?: string;
}

/**
 * Per-recipient Cold SMS campaign step. QStash callback published from
 * /api/comms/sms/campaign/send, always with delaySeconds: 0 — pacing is
 * owned entirely by `enqueuePooledSms`'s per-number rate limiter, not by
 * this route or the fan-out's timing.
 *
 * Deliberately thin: kicks off exactly one `enqueuePooledSms` call and
 * returns. The actual "did it send" outcome — whether it happens inline in
 * this same request or later via the pool's own durability-net callback —
 * is settled by `deliverPooledSms` itself (see `settleCampaignRecipient`
 * in sms-pool.ts), NOT here. This route only handles the one outcome
 * `enqueuePooledSms` can resolve synchronously without ever touching the
 * pool's send machinery: a `blocked` result (no assigned number, that
 * number disabled, or an empty pool) — nothing to defer or retry there,
 * so it's marked skipped immediately.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json({ error: "QStash is not configured." }, { status: 503 });
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Upstash-Signature header" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: StepBody;
  try {
    payload = JSON.parse(rawBody) as StepBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { campaignId, contactId } = payload;
  if (typeof campaignId !== "string" || typeof contactId !== "string") {
    return NextResponse.json({ error: "campaignId and contactId are required" }, { status: 400 });
  }

  const db = getAdminDb();
  const campaignRef = db.collection("smsCampaigns").doc(campaignId);
  const recRef = campaignRef.collection("recipients").doc(contactId);

  const [campaignSnap, recSnap, contactSnap] = await Promise.all([
    campaignRef.get(),
    recRef.get(),
    db.doc(`contacts/${contactId}`).get(),
  ]);
  if (!campaignSnap.exists || !recSnap.exists || !contactSnap.exists) {
    return NextResponse.json({ ok: true, ignored: "missing" });
  }
  const campaign = campaignSnap.data() as SmsCampaignDoc;
  const rec = recSnap.data() as SmsCampaignRecipientDoc;

  if (rec.status !== "queued") {
    return NextResponse.json({ ok: true, ignored: "already_settled" });
  }
  if (campaign.status === "cancelled") {
    await skip(recRef, campaignRef, "cancelled");
    return NextResponse.json({ ok: true, status: "skipped", reason: "cancelled" });
  }
  if (campaign.status === "queued") {
    await campaignRef.update({ status: "sending", startedAt: FieldValue.serverTimestamp() });
  }

  const subSnap = await db.doc(`subAccounts/${rec.subAccountId}`).get();
  const subAccount = subSnap.data() as SubAccountDoc | undefined;
  if (!subAccount) {
    await skip(recRef, campaignRef, "pool_empty");
    return NextResponse.json({ ok: true, status: "skipped", reason: "pool_empty" });
  }

  const contact = { id: contactId, ...(contactSnap.data() as Omit<Contact, "id">) };
  const variant = campaign.messageVariants[rec.variantIndex] ?? campaign.messageVariants[0];
  const subject: MergeTagSubject = {
    contact: { name: contact.name, email: contact.email, phone: contact.phone },
    owner: campaign.ownerSnapshot ?? { displayName: "", email: "" },
    workspace: { name: subAccount.name ?? "" },
    bookingLink: subAccount.bookingLink ?? "",
    paymentLink: subAccount.paymentLink ?? "",
    booking: null,
    industry: subAccount.industry ?? "",
    ltv: subAccount.ltv ?? null,
    unsubscribeLink: "",
    customFields: contact.customFields ?? null,
  };
  const body = resolveMergeTags(variant, subject);

  const result = await enqueuePooledSms({
    subAccountId: rec.subAccountId,
    agencyId: rec.agencyId,
    subAccount,
    contact: { id: contactId, assignedFromNumber: contact.assignedFromNumber },
    to: rec.toPhone,
    body,
    meta: { source: "system", campaignId, campaignRecipientId: contactId },
  });

  if (!result.ok) {
    // Blocked before anything was queued (disabled assigned number, empty
    // pool) — nothing for deliverPooledSms to ever settle, so handle it
    // here directly.
    await skip(
      recRef,
      campaignRef,
      result.reason.toLowerCase().includes("disabled") ? "number_disabled" : "pool_empty",
    );
    return NextResponse.json({ ok: true, status: "skipped", reason: result.reason });
  }

  // Every ok:true variant (pooled inline, pooled deferred, or the legacy
  // non-pool path) either already settled via deliverPooledSms or will via
  // its own QStash durability callback — nothing more to do here.
  return NextResponse.json({ ok: true, status: "dispatched" });
}

async function skip(
  recRef: FirebaseFirestore.DocumentReference,
  campaignRef: FirebaseFirestore.DocumentReference,
  reason: SmsCampaignSkipReason,
): Promise<void> {
  await recRef.set(
    { status: "skipped", skippedReason: reason, settledAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await campaignRef.set(
    {
      "totals.skipped": FieldValue.increment(1),
      "totals.queued": FieldValue.increment(-1),
    },
    { merge: true },
  );
  const snap = await campaignRef.get();
  const data = snap.data() as { status?: string; totals?: { queued?: number } } | undefined;
  if (
    (data?.status === "queued" || data?.status === "sending") &&
    (data?.totals?.queued ?? 0) <= 0
  ) {
    await campaignRef.set(
      { status: "completed", completedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
}
