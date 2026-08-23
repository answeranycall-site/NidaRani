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
 * number still assigned to any contact (surfaces the count so the operator
 * can reassign first — releasing out from under an active contact would
 * silently break their future sends).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; numberId: string }> },
) {
  const { id: subAccountId, numberId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

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

  const assignedSnap = await db
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("assignedFromNumber", "==", number.e164)
    .limit(1)
    .count()
    .get();
  const assignedCount = assignedSnap.data().count;
  if (assignedCount > 0) {
    return NextResponse.json(
      {
        error: `${assignedCount} contact(s) are still assigned to this number — reassign them before releasing it, or their future sends will block.`,
      },
      { status: 400 },
    );
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
