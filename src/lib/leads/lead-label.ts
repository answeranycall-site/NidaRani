import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Fixed placeholder labels for contacts created anonymously (no name
 * volunteered) via Missed Call Text Back, the Web Chat widget, or a cold
 * inbound SMS to a dedicated number — so a brand-new lead never shows up
 * nameless in the CRM (contact list, conversation inbox, etc).
 */

export type LeadLabelKind = "call" | "chat" | "sms";

const KIND_TO_LABEL: Record<LeadLabelKind, string> = {
  call: "New call lead",
  chat: "New chat lead",
  sms: "New SMS lead",
};

/** True when `name` is one of THIS module's own auto-generated placeholder
 *  labels ("New call lead", "New chat lead", "New SMS lead") rather than a
 *  real name the lead gave. Not blank, so a plain empty-string check
 *  misses it — used by {{firstName}} resolvers so customer-facing
 *  templates say "Hi there," instead of "Hi New," for an unnamed lead.
 *
 *  Prefix match, NOT equality: `applyLeadLabelIfUnnamed` appends a phone
 *  suffix ("New SMS lead (…4821)") whenever the number is known, which is
 *  every auto-create path. An equality check therefore never matched a
 *  real-world label and every unnamed lead got greeted "Hi New,". */
export function isSystemLeadLabel(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return false;
  return Object.values(KIND_TO_LABEL).some(
    (label) => trimmed === label || trimmed.startsWith(`${label} (`),
  );
}

export function issueLeadLabel(kind: LeadLabelKind): string {
  return KIND_TO_LABEL[kind];
}

/**
 * If `created` is true and the contact has no name yet, stamp the fixed
 * "New {kind} lead" label onto the contact doc and return it — so the
 * caller can use it immediately (e.g. denormalizing onto a conversation
 * row) without a re-read. Returns `currentName` (trimmed) unchanged
 * otherwise. Best-effort: a labeling failure never breaks the caller's
 * primary flow (text-back send, chat reply, etc).
 */
export async function applyLeadLabelIfUnnamed(input: {
  subAccountId: string;
  contactId: string;
  created: boolean;
  currentName: string | null | undefined;
  kind: LeadLabelKind;
  /** Optional phone to include a snippet in the auto label (last 4 digits).
   *  Improves recognizability in the contact list. */
  phone?: string | null;
}): Promise<string> {
  const trimmed = (input.currentName ?? "").trim();
  if (!input.created || trimmed) return trimmed;

  try {
    let label = issueLeadLabel(input.kind);
    if (input.phone) {
      const p = input.phone.replace(/[^0-9]/g, "");
      const last4 = p.slice(-4);
      if (last4) label = `${label} (…${last4})`;
    }
    await getAdminDb()
      .doc(`contacts/${input.contactId}`)
      .update({ name: label, updatedAt: FieldValue.serverTimestamp() });
    return label;
  } catch (err) {
    console.warn("[lead-label] failed to apply label", err);
    return trimmed;
  }
}
