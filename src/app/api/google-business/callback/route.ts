import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  exchangeGoogleBusinessCode,
  googleBusinessAppConfigured,
  googleBusinessRedirectUri,
  verifyGoogleBusinessState,
} from "@/lib/comms/google-business/oauth";
import {
  listGoogleBusinessAccounts,
  listGoogleBusinessLocations,
} from "@/lib/comms/google-business/api";
import type { SubAccountDoc } from "@/types";

/**
 * Single shared OAuth callback for the Google Business Profile connect flow
 * (Google Reviews Sync). Mirrors /api/meta/callback's shape exactly — see
 * that file for why the redirect URI is one fixed value and the
 * sub-account travels in the signed `state` instead of the URL path.
 *
 * v1: connects the first Business Profile account + its first location.
 * Multi-location selection is deferred, same simplification Meta's connect
 * flow makes for multi-Page accounts.
 */

function appBase(request: Request): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const declined = url.searchParams.get("error");

  if (!state) {
    return NextResponse.redirect(
      new URL("/agency/sub-accounts?gbp=bad_state", appBase(request)),
    );
  }
  const verified = verifyGoogleBusinessState(state);
  if (!verified) {
    return NextResponse.redirect(
      new URL("/agency/sub-accounts?gbp=bad_state", appBase(request)),
    );
  }
  const id = verified.subAccountId;

  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(`/sa/${id}/dashboard/settings`, appBase(request));
  const finish = (status: string) => {
    settingsUrl.searchParams.set("gbp", status);
    return NextResponse.redirect(settingsUrl);
  };

  if (declined || !code) return finish("cancelled");
  if (!googleBusinessAppConfigured()) return finish("not_configured");

  const redirectUri = googleBusinessRedirectUri();
  if (!redirectUri) return finish("not_configured");

  const db = getAdminDb();
  const snap = await db.doc(`subAccounts/${id}`).get();
  const sa = snap.exists ? (snap.data() as SubAccountDoc) : null;
  if (sa?.googleReviewsSyncEnabledByAgency !== true) return finish("gate_off");

  try {
    const tokens = await exchangeGoogleBusinessCode(code, redirectUri);
    if (!tokens.refreshToken) {
      // No refresh token means the user had previously granted consent and
      // Google skipped re-issuing one (prompt=consent should prevent this,
      // but guard anyway) — without it we can't sync after the access
      // token expires, so treat as a failure and ask them to reconnect.
      return finish("no_refresh_token");
    }

    const accounts = await listGoogleBusinessAccounts(tokens.accessToken);
    if (accounts.length === 0) return finish("no_accounts");
    const account = accounts[0];

    const locations = await listGoogleBusinessLocations(
      tokens.accessToken,
      account.accountId,
    );
    if (locations.length === 0) return finish("no_locations");
    const location = locations[0];

    await db.doc(`subAccounts/${id}`).update({
      googleBusinessConfig: {
        accountId: account.accountId,
        locationId: location.locationId,
        locationName: location.name,
        address: location.address,
        phone: location.phone,
        websiteUri: location.websiteUri,
        mapsUri: location.mapsUri,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.expiresAt,
        averageRating: null,
        totalReviewCount: null,
        lastSyncedAt: null,
        lastSyncError: null,
        connectedByUid: access.uid,
        connectedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });

    return finish("connected");
  } catch (err) {
    console.error(`[google-business/callback] connect failed sa=${id}`, err);
    return finish("error");
  }
}
