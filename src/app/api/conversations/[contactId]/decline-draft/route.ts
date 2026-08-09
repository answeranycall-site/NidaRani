import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { resumeWorkflowRunAfterApproval } from "@/lib/workflows/engine";
import type { ConversationDraft } from "@/types/conversations";

/**
 * Decline a conversation draft. Ordinary suggest-mode drafts are discarded
 * straight from the client via `discardConversationDraft` (a plain Firestore
 * write — no server route needed). This route exists specifically for
 * drafts sourced from a paused Workflow Builder run (the AI Booking +
 * Nurture chain, `pendingDraft.workflowRunId` set): declining one needs the
 * Admin-SDK `resumeWorkflowRunAfterApproval` call so the paused run advances
 * immediately (down the `whenFalse` / no-op path) instead of waiting out its
 * own approval-timeout. `ConversationDraftCard` posts here only when
 * `draft.workflowRunId` is set; every other draft keeps using the client-side
 * discard.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ contactId: string }> },
) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  const { contactId } = await ctx.params;
  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const db = getAdminDb();
  const convoRef = db.doc(`conversations/${contactId}`);
  const convoSnap = await convoRef.get();
  const pendingDraft = convoSnap.data()?.pendingDraft as
    | ConversationDraft
    | undefined;

  if (pendingDraft) {
    await convoRef.set(
      { pendingDraft: null, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  if (pendingDraft?.workflowRunId) {
    void resumeWorkflowRunAfterApproval(pendingDraft.workflowRunId, {
      approved: false,
    }).catch((err) =>
      console.warn("[conversations/decline-draft] workflow resume failed", err),
    );
  }

  return NextResponse.json({ ok: true });
}
