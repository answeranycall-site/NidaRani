import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import type { Contact } from "@/types/contacts";
import type { MemberStatus, Role } from "@/types";

/**
 * Restore a soft-deleted contact — clears `deletedAt` on the contact and
 * its `conversations/{id}` index doc (if any). Same admin-only auth model
 * as the DELETE route it undoes. No-ops (200) if the contact was never
 * deleted, so a doubled restore click can't error.
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
      { error: "Only sub-account admins can restore contacts." },
      { status: 403 },
    );
  }

  await contactRef.set({ deletedAt: null }, { merge: true });
  try {
    const convoRef = db.doc(`conversations/${id}`);
    const convoSnap = await convoRef.get();
    if (convoSnap.exists) {
      await convoRef.set({ deletedAt: null }, { merge: true });
    }
  } catch (err) {
    console.warn(`[contacts/${id}/restore] conversation mirror failed`, err);
  }

  return NextResponse.json({ ok: true, contactId: id });
}
