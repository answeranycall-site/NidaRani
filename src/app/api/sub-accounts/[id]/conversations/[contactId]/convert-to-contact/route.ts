import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { createContactServerSide } from "@/lib/server/contacts-service";

/**
 * Converts an "Unknown person" placeholder conversation (an inbound SMS that
 * matched no existing Contact — see the pseudoContactId() branch in
 * src/app/api/webhooks/twilio/inbound/route.ts) into a real Contact.
 *
 * Migrates the placeholder's message history + conversation state onto the
 * new contact id so nothing is lost, then deletes the placeholder docs.
 * Phone is pre-filled from the conversation and editable (the operator can
 * fix a typo); it only falls back to the conversation's stored phone if
 * the field comes back empty.
 *
 * Auth: any active sub-account member (matches the plain contact-creation
 * route's policy).
 */

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; contactId: string }> },
) {
  const { id: subAccountId, contactId: pseudoId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = getAdminDb();

  const [convoSnap, contactSnap] = await Promise.all([
    db.doc(`conversations/${pseudoId}`).get(),
    db.doc(`contacts/${pseudoId}`).get(),
  ]);

  if (!convoSnap.exists) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  }
  const convo = convoSnap.data() as {
    subAccountId?: string;
    contactId?: string;
    contactPhone?: string | null;
  };
  if (convo.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (contactSnap.exists) {
    return NextResponse.json(
      { error: "This conversation is already linked to a real contact." },
      { status: 400 },
    );
  }

  const name = str(body.name, 200);
  // Pre-filled from the conversation, but the operator can correct a typo —
  // fall back to the conversation's phone only if they cleared the field.
  const phone = str(body.phone) || convo.contactPhone || "";
  if (!phone) {
    return NextResponse.json(
      { error: "This conversation has no phone number to convert." },
      { status: 400 },
    );
  }

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string) ?? access.agencyId ?? "";

  const { id: newContactId, contact } = await createContactServerSide({
    subAccountId,
    agencyId,
    createdByUid: access.uid,
    mode: "live",
    name,
    email: str(body.email),
    phone,
    company: str(body.company),
    address: str(body.address),
    source: str(body.source) || "other",
    tags: strArray(body.tags),
  });

  // Migrate the placeholder's message history + conversation state onto the
  // new contact id, then remove the placeholder docs. Message counts on an
  // unconverted thread are small (a handful of texts before conversion), so
  // one batch comfortably covers it.
  const messagesSnap = await db
    .collection("contacts")
    .doc(pseudoId)
    .collection("messages")
    .get();

  const batch = db.batch();
  for (const msgDoc of messagesSnap.docs) {
    batch.set(
      db
        .collection("contacts")
        .doc(newContactId)
        .collection("messages")
        .doc(msgDoc.id),
      { ...msgDoc.data(), contactId: newContactId },
    );
    batch.delete(msgDoc.ref);
  }
  batch.set(db.doc(`conversations/${newContactId}`), {
    ...convo,
    contactId: newContactId,
    contactName: name || convo.contactPhone || "",
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.delete(convoSnap.ref);
  await batch.commit();

  return NextResponse.json({ ok: true, contactId: newContactId, contact });
}
