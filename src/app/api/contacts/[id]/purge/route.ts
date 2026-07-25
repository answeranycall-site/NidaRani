import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import type { Contact } from "@/types/contacts";
import type { MemberStatus, Role } from "@/types";

/**
 * Permanently delete a contact that's already soft-deleted — the "Delete
 * permanently" action in the Conversations "Deleted" tab, for an operator
 * who doesn't want to wait out the full retention window. Refuses (400) if
 * the contact isn't currently soft-deleted, so this can't be used to skip
 * the grace period entirely — DELETE /api/contacts/[id] must run first.
 * Same admin-only auth model as that route.
 */

interface CallerClaims {
  status?: MemberStatus;
  agencyId?: string | null;
  agencyRole?: "owner" | "staff" | null;
  role?: Role;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const record = await getAdminAuth().getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }

  const db = getAdminDb();
  const contactRef = db.doc(`contacts/${id}`);
  const snap = await contactRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const contact = snap.data() as Omit<Contact, "id">;
  const { agencyId, subAccountId } = contact;

  const isAgencyOwner =
    claims.agencyRole === "owner" && claims.agencyId === agencyId;
  let isSubAccountAdmin = false;
  if (!isAgencyOwner) {
    const memberSnap = await db
      .doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`)
      .get();
    const member = memberSnap.data();
    isSubAccountAdmin =
      memberSnap.exists &&
      member?.status === "active" &&
      member?.role === "admin";
  }
  if (!isAgencyOwner && !isSubAccountAdmin) {
    return NextResponse.json(
      { error: "Only sub-account admins can permanently delete contacts." },
      { status: 403 },
    );
  }

  if (!contact.deletedAt) {
    return NextResponse.json(
      { error: "This contact isn't in the Deleted tab — delete it first." },
      { status: 400 },
    );
  }

  await db.recursiveDelete(contactRef);
  await db.doc(`conversations/${id}`).delete().catch(() => {});

  return NextResponse.json({ ok: true, contactId: id });
}
