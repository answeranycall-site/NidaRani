import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { syncGoogleReviews } from "@/lib/comms/google-business/sync";
import type { SubAccountDoc } from "@/types";

/**
 * Manual "Sync now" — mirrors the website builder's poll-now pattern.
 * Google Business Profile has no review webhook, so this is the only way
 * an operator gets fresh reviews without waiting for the daily cron
 * (/api/cron/google-reviews-sync).
 *
 *   POST /api/sub-accounts/[id]/google-business/sync
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const sa = snap.exists ? (snap.data() as SubAccountDoc) : null;
  if (sa?.googleReviewsSyncEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Google Reviews Sync is disabled by your agency." },
      { status: 403 },
    );
  }
  if (!sa.googleBusinessConfig) {
    return NextResponse.json(
      { error: "Connect a Google Business account first." },
      { status: 400 },
    );
  }

  const result = await syncGoogleReviews(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Sync failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, newReviewCount: result.newReviewCount });
}
