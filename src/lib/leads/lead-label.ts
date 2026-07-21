import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Sequential, per-sub-account "Lead {kind} #N" labels for contacts created
 * anonymously (no name volunteered) via Missed Call Text Back, the Web Chat
 * widget, or a cold inbound SMS to a dedicated number — so a brand-new lead
 * never shows up nameless in the CRM (contact list, conversation inbox, etc).
 *
 * Counter doc: subAccounts/{id}/counters/leadLabels — { call: n, chat: n,
 * sms: n }, atomically incremented via a Firestore transaction (same pattern
 * as lib/quotes/number.ts).
 */

export type LeadLabelKind = "call" | "chat" | "sms";

const KIND_TO_LABEL: Record<LeadLabelKind, string> = {
  call: "Lead call",
  chat: "Lead chat",
  sms: "Lead text",
};

export async function issueLeadLabel(
  subAccountId: string,
  kind: LeadLabelKind,
): Promise<string> {
  const db = getAdminDb();
  const counterRef = db.doc(`subAccounts/${subAccountId}/counters/leadLabels`);

  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? (snap.data() as Record<string, number>) : {};
    const next = (data[kind] ?? 0) + 1;
    tx.set(
      counterRef,
      { [kind]: next, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return next;
  });

  return `${KIND_TO_LABEL[kind]} #${seq}`;
}

/**
 * If `created` is true and the contact has no name yet, stamp the next
 * sequential "Lead {kind} #N" label onto the contact doc and return it —
 * so the caller can use it immediately (e.g. denormalizing onto a
 * conversation row) without a re-read. Returns `currentName` (trimmed)
 * unchanged otherwise. Best-effort: a labeling failure never breaks the
 * caller's primary flow (text-back send, chat reply, etc).
 */
export async function applyLeadLabelIfUnnamed(input: {
  subAccountId: string;
  contactId: string;
  created: boolean;
  currentName: string | null | undefined;
  kind: LeadLabelKind;
}): Promise<string> {
  const trimmed = (input.currentName ?? "").trim();
  if (!input.created || trimmed) return trimmed;

  try {
    const label = await issueLeadLabel(input.subAccountId, input.kind);
    await getAdminDb()
      .doc(`contacts/${input.contactId}`)
      .update({ name: label, updatedAt: FieldValue.serverTimestamp() });
    return label;
  } catch (err) {
    console.warn("[lead-label] failed to apply label", err);
    return trimmed;
  }
}
