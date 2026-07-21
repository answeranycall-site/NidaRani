import "server-only";

import { NextResponse } from "next/server";
import {
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { getAdminDb } from "@/lib/firebase/admin";
import { commitRating } from "@/lib/reviews/rating-reply";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

/**
 * Fires RATING_HOLD_WINDOW_SEC after a clean, unambiguous rating digit was
 * read, to actually commit it (send the Google link / apology). Public
 * path; security is the Upstash signature (same model as
 * /api/workflows/step).
 *
 * Supersession guard: re-reads the contact fresh and only commits if
 * `pendingRatingHoldValue` still equals `expectedValue` — if a conflicting
 * reply arrived during the hold, lib/reviews/rating-reply.ts::handleDuringHold
 * already cleared/changed it and moved to the confirm flow instead, so this
 * becomes a harmless no-op.
 */

interface CommitRatingPayload {
  subAccountId?: string;
  agencyId?: string;
  contactId?: string;
  expectedValue?: number;
}

export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: CommitRatingPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { subAccountId, agencyId, contactId, expectedValue } = payload;
  if (!subAccountId || !contactId || typeof expectedValue !== "number") {
    return NextResponse.json(
      { error: "Malformed commit-rating payload" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const [contactSnap, saSnap] = await Promise.all([
    db.doc(`contacts/${contactId}`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  if (!contactSnap.exists || !saSnap.exists) {
    return NextResponse.json({ ok: true, skipped: "not_found" });
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };
  const subAccount = saSnap.data() as SubAccountDoc;

  if (contact.pendingRatingHoldValue !== expectedValue) {
    // Superseded by a conflicting reply (or already resolved another way)
    // during the hold — nothing left to do.
    return NextResponse.json({ ok: true, skipped: "superseded" });
  }

  await commitRating(
    {
      subAccountId,
      agencyId: agencyId ?? subAccount.agencyId,
      contact,
      subAccount,
      body: "",
    },
    expectedValue,
  );

  return NextResponse.json({ ok: true });
}
