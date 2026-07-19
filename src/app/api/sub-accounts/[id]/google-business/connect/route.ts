import "server-only";

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  buildGoogleBusinessOAuthUrl,
  googleBusinessAppConfigured,
  googleBusinessRedirectUri,
  signGoogleBusinessState,
} from "@/lib/comms/google-business/oauth";
import type { SubAccountDoc } from "@/types";

/**
 * Kick off the Google Business Profile connect flow (Google Reviews Sync).
 *
 *   GET /api/sub-accounts/[id]/google-business/connect
 *
 * Sub-account admin only. Requires the agency gate
 * (`googleReviewsSyncEnabledByAgency`) on and the deployment to have Google
 * OAuth creds configured. On success redirects to Google's consent screen;
 * any guard miss redirects back to Settings with a `?gbp=…` status.
 */

function appBase(request: Request): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(`/sa/${id}/dashboard/settings`, appBase(request));

  const snap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const sa = snap.exists ? (snap.data() as SubAccountDoc) : null;

  if (sa?.googleReviewsSyncEnabledByAgency !== true) {
    settingsUrl.searchParams.set("gbp", "gate_off");
    return NextResponse.redirect(settingsUrl);
  }
  if (!googleBusinessAppConfigured()) {
    settingsUrl.searchParams.set("gbp", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }
  const redirectUri = googleBusinessRedirectUri();
  if (!redirectUri) {
    settingsUrl.searchParams.set("gbp", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const state = signGoogleBusinessState(id, nonce);
  return NextResponse.redirect(
    buildGoogleBusinessOAuthUrl({ redirectUri, state }),
  );
}
