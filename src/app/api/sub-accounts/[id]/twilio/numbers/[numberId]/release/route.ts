import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { buildTwilioClient } from "@/lib/comms/twilio";
import type { SubAccountDoc, TwilioConfig, TwilioPoolNumber } from "@/types";

/**
 * "Request deletion" — actually releases the number from Twilio (stops the
 * recurring charge) and, on confirmation, archives the Firestore doc
 * (`archivedAt` set, doc kept for history — stats + which contacts were
 * assigned to it stay queryable). Distinct from the sibling route's plain
 * DELETE, which only stops OUR tracking and leaves the number live/billing
 * in Twilio — this is the serious, irreversible action.
 *
 * Refuses on the current primary (same guard as plain delete) and on a
 * number still assigned to any contact — UNLESS the caller passes
 * `reassignTo` (another enabled, non-archived number in this same pool),
 * in which case every assigned contact is bulk-repointed to that number
 * (their `assignedFromNumberLockedAt` is left as-is — a contact who already
 * had a real conversation stays "locked" to a specific number, just a
 * different one, preserving the pool's "block, don't silently reroute"
 * guarantee for any FUTURE release too) before the release proceeds.
 * Without `reassignTo`, the count is surfaced so the operator can choose.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; numberId: string }> },
) {
  const { id: subAccountId, numberId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const body = await request.json().catch(() => ({}) as { reassignTo?: unknown });
  const reassignTo =
    typeof (body as { reassignTo?: unknown }).reassignTo === "string"
      ? ((body as { reassignTo: string }).reassignTo.trim() || null)
      : null;

  const db = getAdminDb();
  const [numberSnap, subSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;
  if (!numberSnap.exists) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }
  const number = numberSnap.data() as TwilioPoolNumber;
  if (number.archivedAt) {
    return NextResponse.json({ ok: true, alreadyArchived: true });
  }
  if (number.isPrimary) {
    return NextResponse.json(
      {
        error:
          "This is the primary number for the pool — set a different number as primary before releasing it.",
      },
      { status: 400 },
    );
  }

  const assignedQuery = db
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("assignedFromNumber", "==", number.e164);

  if (!reassignTo) {
    const assignedSnap = await assignedQuery.limit(1).count().get();
    const assignedCount = assignedSnap.data().count;
    if (assignedCount > 0) {
      return NextResponse.json(
        {
          error: `${assignedCount} contact(s) are still assigned to this number — reassign them before releasing it, or their future sends will block.`,
          assignedCount,
        },
        { status: 400 },
      );
    }
  } else {
    if (reassignTo === number.e164) {
      return NextResponse.json(
        { error: "Can't reassign a number's contacts to itself." },
        { status: 400 },
      );
    }
    const targetSnap = await db
      .collection(`subAccounts/${subAccountId}/twilioNumbers`)
      .where("e164", "==", reassignTo)
      .limit(1)
      .get();
    const target = targetSnap.docs[0]?.data() as TwilioPoolNumber | undefined;
    if (!target || target.archivedAt || !target.enabled) {
      return NextResponse.json(
        { error: "The reassignment target isn't an enabled number in this pool." },
        { status: 400 },
      );
    }
    const assignedDocs = await assignedQuery.get();
    if (!assignedDocs.empty) {
      const batches: Promise<FirebaseFirestore.WriteResult[]>[] = [];
      let batch = db.batch();
      let opsInBatch = 0;
      for (const doc of assignedDocs.docs) {
        batch.update(doc.ref, {
          assignedFromNumber: reassignTo,
          updatedAt: FieldValue.serverTimestamp(),
        });
        opsInBatch++;
        if (opsInBatch === 450) {
          batches.push(batch.commit());
          batch = db.batch();
          opsInBatch = 0;
        }
      }
      if (opsInBatch > 0) batches.push(batch.commit());
      await Promise.all(batches);
    }
  }

  const cfg = (subSnap.data()?.twilioConfig as TwilioConfig | undefined) ?? null;
  if (!cfg?.accountSid || !cfg.authToken) {
    return NextResponse.json(
      { error: "Twilio credentials not configured for this sub-account." },
      { status: 400 },
    );
  }

  try {
    const client = buildTwilioClient(cfg.accountSid, cfg.authToken);
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: number.e164,
      limit: 1,
    });
    if (list.length === 0) {
      // Already gone on Twilio's side (released manually, e.g.) — treat as
      // success and archive so it stops showing as a live number here.
      await numberSnap.ref.set(
        {
          archivedAt: FieldValue.serverTimestamp(),
          enabled: false,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return NextResponse.json({ ok: true, alreadyReleasedOnTwilio: true });
    }
    await client.incomingPhoneNumbers(list[0].sid).remove();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Twilio rejected the release request.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  await numberSnap.ref.set(
    {
      archivedAt: FieldValue.serverTimestamp(),
      enabled: false,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return NextResponse.json({ ok: true });
}
