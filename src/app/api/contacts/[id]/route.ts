import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  emitContactDeleted,
  updateContactServerSide,
  type UpdateContactPatch,
} from "@/lib/server/contacts-service";
import type { Contact } from "@/types/contacts";
import type { MemberStatus, Role } from "@/types";

/**
 * Delete a contact — always succeeds, regardless of what else still points
 * at it (deals, tasks, quotes, etc. are left exactly as they are; they'll
 * just reference a contact that's now hidden).
 *
 * Auth model: caller must be a sub-account ADMIN of the contact's
 * sub-account (or the agency owner). Collaborators can edit but not
 * delete — matches the rule for `contacts/{id}` where delete requires
 * canAdminSub.
 *
 * Soft-delete, not a hard delete: stamps `deletedAt` on the contact (and
 * its `conversations/{id}` index doc, if one exists) instead of removing
 * anything. The contact disappears from list views and the Conversations
 * "active" tab immediately, but is fully restorable from the Conversations
 * "Deleted" tab until the daily cron (api/cron/purge-deleted-contacts)
 * permanently removes anything past DELETED_CONTACT_RETENTION_DAYS.
 * `?check=1` still runs the linked-records check as a dry-run (200 with
 * `deletable` + `blockers`, no writes) purely for informational UI copy —
 * it no longer blocks anything.
 */

interface CallerClaims {
  status?: MemberStatus;
  agencyId?: string | null;
  agencyRole?: "owner" | "staff" | null;
  role?: Role;
}

async function readCaller(request: Request): Promise<
  | { uid: string; email: string; claims: CallerClaims }
  | NextResponse
> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const auth = getAdminAuth();
  const record = await auth.getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  return { uid, email: record.email ?? "", claims };
}

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Update a contact's plain fields + emit `contact.updated`. Any active
 * member may edit (matches the old client-SDK write rule). Territory moves
 * are NOT handled here — the dashboard routes those through the dedicated
 * territory fan-out endpoint.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`contacts/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const data = snap.data() as Omit<Contact, "id">;

  const access = await requireSubAccountMember(request, data.subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: UpdateContactPatch = {};
  if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 200);
  if (typeof body.email === "string") patch.email = str(body.email);
  if (typeof body.phone === "string") patch.phone = str(body.phone);
  if (typeof body.company === "string") patch.company = str(body.company);
  if (typeof body.address === "string") patch.address = str(body.address);
  if (typeof body.source === "string") patch.source = str(body.source);
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  if (body.pipelineStage === null || typeof body.pipelineStage === "string") {
    patch.pipelineStage =
      typeof body.pipelineStage === "string" ? body.pipelineStage : null;
  }

  const result = await updateContactServerSide({
    contactId: id,
    patch,
    mode: (data as { mode?: "live" | "test" }).mode ?? "live",
  });
  if (!result) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return NextResponse.json({
    contact: result.contact,
    ...(result.blockedTags ? { blockedTags: result.blockedTags } : {}),
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const caller = await readCaller(request);
  if (caller instanceof NextResponse) return caller;

  const db = getAdminDb();
  const contactRef = db.doc(`contacts/${id}`);
  const snap = await contactRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const contact = snap.data() as Omit<Contact, "id">;
  const { agencyId, subAccountId } = contact;

  // Authorisation: agency owner of the contact's agency, OR sub-account
  // admin of the contact's sub-account.
  const isAgencyOwner =
    caller.claims.agencyRole === "owner" &&
    caller.claims.agencyId === agencyId;

  let isSubAccountAdmin = false;
  if (!isAgencyOwner) {
    const memberSnap = await db
      .doc(`subAccounts/${subAccountId}/subAccountMembers/${caller.uid}`)
      .get();
    const member = memberSnap.data();
    isSubAccountAdmin =
      memberSnap.exists &&
      member?.status === "active" &&
      member?.role === "admin";
  }

  if (!isAgencyOwner && !isSubAccountAdmin) {
    return NextResponse.json(
      { error: "Only sub-account admins can delete contacts." },
      { status: 403 },
    );
  }

  // Dry-run for the UI: still surfaces what's linked (informational only —
  // it never blocks the actual delete below).
  const checkOnly = new URL(request.url).searchParams.get("check") === "1";
  if (checkOnly) {
    const blockers = await findContactBlockers(db, subAccountId, id);
    return NextResponse.json({ deletable: true, blockers });
  }

  // Soft-delete: stamp deletedAt rather than removing anything. Restorable
  // from the Conversations "Deleted" tab until the daily purge cron clears
  // it after DELETED_CONTACT_RETENTION_DAYS.
  const deletedAt = FieldValue.serverTimestamp();
  await contactRef.set({ deletedAt }, { merge: true });

  // Mirror onto the conversation index doc too, if one exists, so the
  // Conversations list can filter to/without an extra contact read per row.
  try {
    const convoRef = db.doc(`conversations/${id}`);
    const convoSnap = await convoRef.get();
    if (convoSnap.exists) {
      await convoRef.set({ deletedAt }, { merge: true });
    }
  } catch (err) {
    console.warn(`[contacts/${id}] conversation soft-delete mirror failed`, err);
  }

  // Fire contact.deleted now — from the operator's perspective the contact
  // is gone the moment they delete it, even though the doc survives for
  // the grace window. The eventual permanent purge does NOT re-fire this.
  emitContactDeleted({ subAccountId, agencyId, contactId: id, data: contact });

  return NextResponse.json({ ok: true, contactId: id, softDeleted: true });
}

interface ContactBlocker {
  type: string;
  /** Singular human label, e.g. "deal" → "2 deals". */
  label: string;
  count: number;
}

/**
 * Count every record that points at this contact across the resources a
 * delete must not orphan. Any non-zero count blocks the delete. Uses
 * count() aggregation so we never read the docs themselves.
 */
async function findContactBlockers(
  db: FirebaseFirestore.Firestore,
  subAccountId: string,
  contactId: string,
): Promise<ContactBlocker[]> {
  const inSub = (collection: string) =>
    db
      .collection(collection)
      .where("subAccountId", "==", subAccountId)
      .where("contactId", "==", contactId)
      .count()
      .get();

  const [deals, tasks, events, quotes, submissions, webChats, voiceCalls] =
    await Promise.all([
      inSub("deals"),
      inSub("tasks"),
      inSub("events"),
      inSub("quotes"),
      // Form submissions live in forms/{id}/submissions — a collection-group
      // query finds them across every form. contactId is a globally unique
      // doc id, so no sub-account filter is needed.
      db
        .collectionGroup("submissions")
        .where("contactId", "==", contactId)
        .count()
        .get(),
      db
        .collection("subAccounts")
        .doc(subAccountId)
        .collection("webChatSessions")
        .where("contactId", "==", contactId)
        .count()
        .get(),
      db
        .collection("subAccounts")
        .doc(subAccountId)
        .collection("voiceCalls")
        .where("contactId", "==", contactId)
        .count()
        .get(),
    ]);

  const out: ContactBlocker[] = [];
  const add = (count: number, type: string, label: string) => {
    if (count > 0) out.push({ type, label, count });
  };
  add(deals.data().count, "deals", "deal");
  add(tasks.data().count, "tasks", "task");
  add(events.data().count, "events", "calendar event / booking");
  add(quotes.data().count, "quotes", "quote / invoice");
  add(submissions.data().count, "form_submissions", "form submission");
  add(webChats.data().count, "web_chat_sessions", "web-chat conversation");
  add(voiceCalls.data().count, "voice_calls", "voice call");
  return out;
}
