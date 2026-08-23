import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Cold SMS campaign code generator. Format `SC-YYYY-NNNN` (e.g.
 * SC-2026-0001), per-sub-account, resets each year. Mirrors
 * `lib/comms/voice/campaign-number.ts` exactly.
 *
 * Counter doc: subAccounts/{subAccountId}/counters/smsCampaignNumbers
 */

const PADDING = 4;

export async function issueSmsCampaignCode(
  subAccountId: string,
  now: Date = new Date(),
): Promise<string> {
  if (!subAccountId) throw new Error("subAccountId required");
  const year = now.getUTCFullYear();

  const db = getAdminDb();
  const counterRef = db
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("counters")
    .doc("smsCampaignNumbers");

  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? snap.data() : null;
    const sameYear = data && data.year === year;
    const nextSeq = (sameYear ? (data?.seq ?? 0) : 0) + 1;
    tx.set(counterRef, { year, seq: nextSeq, updatedAt: new Date() }, { merge: true });
    return nextSeq;
  });

  return `SC-${year}-${String(seq).padStart(PADDING, "0")}`;
}
