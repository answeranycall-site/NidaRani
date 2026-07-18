import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Cap on distinct tag VALUES a sub-account can ever have in use — not a
 * per-contact limit. Tracked on `subAccounts/{id}.tagRegistry` (the set of
 * every tag name ever accepted for that sub-account) so a new, never-seen
 * tag can be refused once the cap is reached, while re-using an existing
 * tag on any number of contacts always stays free.
 */
export const MAX_TAGS_PER_SUBACCOUNT = 7;

/**
 * Filters `requestedTags` down to the ones allowed under the cap. A tag
 * already in the registry is always allowed (it doesn't consume a new
 * slot); a brand-new tag is allowed only while there's room, and reserves
 * its slot transactionally so two concurrent requests near the cap can't
 * both slip through and overshoot it.
 *
 * Scoped to the two operator-driven paths that actually introduce new tag
 * values in normal use — the contact-edit form (via updateContactServerSide)
 * and the Workflow Builder's add_tag node. Bulk/automated ingestion (CSV
 * import, GHL import, public v1 API, form/webhook auto-tagging) doesn't
 * call this yet.
 */
export async function reserveTags(
  subAccountId: string,
  requestedTags: string[],
): Promise<{ allowed: string[]; blocked: string[] }> {
  const uniqueRequested = [
    ...new Set(requestedTags.map((t) => t.trim()).filter(Boolean)),
  ];
  if (uniqueRequested.length === 0) return { allowed: [], blocked: [] };

  const ref = getAdminDb().doc(`subAccounts/${subAccountId}`);
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const registry: string[] = Array.isArray(snap.data()?.tagRegistry)
      ? (snap.data()!.tagRegistry as string[])
      : [];
    const registrySet = new Set(registry);
    const allowed: string[] = [];
    const blocked: string[] = [];
    const additions: string[] = [];

    for (const tag of uniqueRequested) {
      if (registrySet.has(tag)) {
        allowed.push(tag);
        continue;
      }
      if (registry.length + additions.length < MAX_TAGS_PER_SUBACCOUNT) {
        additions.push(tag);
        allowed.push(tag);
      } else {
        blocked.push(tag);
      }
    }

    if (additions.length > 0) {
      tx.set(
        ref,
        { tagRegistry: FieldValue.arrayUnion(...additions) },
        { merge: true },
      );
    }

    return { allowed, blocked };
  });
}
