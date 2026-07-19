import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { syncGoogleReviews } from "@/lib/comms/google-business/sync";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Daily QStash callback that syncs Google reviews for every sub-account
 * with Google Reviews Sync connected. Google Business Profile has no
 * review webhook, so this schedule (see lib/qstash/register-schedules.ts)
 * is the only automatic path to fresh reviews + the owner "new review"
 * SMS — operators can also trigger a sync manually via the "Sync now"
 * button (POST /api/sub-accounts/[id]/google-business/sync).
 *
 * Sequential, not parallel — sub-account counts here are small and this
 * avoids bursting Google's per-minute quota across many sub-accounts at
 * once. One bad connection's failure is recorded on its own config and
 * never blocks the rest (syncGoogleReviews never throws).
 *
 * The middleware lets this path through unauthenticated; security comes
 * from QStash's Upstash-Signature header.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const snap = await getAdminDb()
    .collection("subAccounts")
    .where("googleReviewsSyncEnabledByAgency", "==", true)
    .get();

  const connected = snap.docs.filter(
    (d) => !!(d.data() as SubAccountDoc).googleBusinessConfig,
  );

  const results: Array<{ subAccountId: string; ok: boolean; newReviewCount: number }> = [];
  for (const doc of connected) {
    const result = await syncGoogleReviews(doc.id);
    results.push({
      subAccountId: doc.id,
      ok: result.ok,
      newReviewCount: result.newReviewCount,
    });
  }

  return NextResponse.json({ ok: true, synced: results.length, results });
}
