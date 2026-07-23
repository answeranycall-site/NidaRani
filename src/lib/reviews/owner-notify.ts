import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  DEFAULT_OWNER_REQUEST_SENT_TEMPLATE,
  DEFAULT_OWNER_REMINDER_TIMEOUT_TEMPLATE,
  DEFAULT_OWNER_REMINDER_SENT_TEMPLATE,
  renderOwnerNotifyTemplate,
} from "@/lib/reviews/constants";
import type { AgencyDoc } from "@/types";

export type OwnerNotifyKind = "requestSent" | "reminderTimeout" | "reminderSent";

const DEFAULTS: Record<OwnerNotifyKind, string> = {
  requestSent: DEFAULT_OWNER_REQUEST_SENT_TEMPLATE,
  reminderTimeout: DEFAULT_OWNER_REMINDER_TIMEOUT_TEMPLATE,
  reminderSent: DEFAULT_OWNER_REMINDER_SENT_TEMPLATE,
};

/**
 * Renders one of the three review-rating-gate owner-notify texts using the
 * agency's own customized copy (Agency → Settings → Review requests — owner
 * notifications) when set, falling back to the shipped default otherwise.
 */
export async function renderOwnerNotify(
  agencyId: string,
  kind: OwnerNotifyKind,
  vars: { clientName: string; clientPhone: string; businessName: string },
): Promise<string> {
  const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
  const templates = (snap.data() as AgencyDoc | undefined)
    ?.reviewOwnerNotifyTemplates;
  const template = templates?.[kind]?.trim() || DEFAULTS[kind];
  return renderOwnerNotifyTemplate(template, vars);
}
