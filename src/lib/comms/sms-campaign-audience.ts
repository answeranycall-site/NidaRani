import "server-only";

import { parsePhoneNumberFromString } from "libphonenumber-js";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastAudienceFilter } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Resolve a Cold SMS campaign's audience — mirrors `lib/comms/voice/
 * audience.ts` but pre-filters on `smsOptedOut` instead of `voiceOptedOut`.
 * No suppression layers in v1 (recently-texted / prior-campaign exclusion)
 * — the operator's audience filter (all / tag / pipeline stage) plus a
 * fresh CSV import's own tag is enough for a first cold touch; add
 * suppression if repeat campaigns become common.
 */
export type SmsCampaignAudienceSkipReason = "opted_out" | "no_phone";

export interface ResolvedSmsCampaignAudience {
  recipients: Contact[];
  skipped: Array<{ contact: Contact; reason: SmsCampaignAudienceSkipReason }>;
}

export async function resolveSmsCampaignAudience(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
  territoryFilter: string[] | null = null,
): Promise<ResolvedSmsCampaignAudience> {
  const db = getAdminDb();
  let query: FirebaseFirestore.Query = db
    .collection("contacts")
    .where("subAccountId", "==", subAccountId);

  if (filter.kind === "tag") {
    query = query.where("tags", "array-contains", filter.tag);
  } else if (filter.kind === "pipeline_stage") {
    query = query.where("pipelineStage", "==", filter.stage);
  }

  const snap = await query.get();
  const recipients: Contact[] = [];
  const skipped: ResolvedSmsCampaignAudience["skipped"] = [];

  for (const doc of snap.docs) {
    const contact = { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
    if (territoryFilter) {
      const tId = contact.territoryId ?? null;
      if (!tId || !territoryFilter.includes(tId)) continue;
    }
    if (contact.smsOptedOut === true) {
      skipped.push({ contact, reason: "opted_out" });
      continue;
    }
    const parsed = contact.phone ? parsePhoneNumberFromString(contact.phone) : null;
    if (!parsed || !parsed.isValid()) {
      skipped.push({ contact, reason: "no_phone" });
      continue;
    }
    recipients.push(contact);
  }

  return { recipients, skipped };
}
