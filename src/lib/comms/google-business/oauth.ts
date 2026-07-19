import "server-only";

import crypto from "node:crypto";

/**
 * Google Business Profile OAuth wrapper — powers Google Reviews Sync.
 * Mirrors the shape of lib/comms/meta.ts: pure helpers + REST calls, no
 * Firestore writes.
 *
 * IMPORTANT external caveat: reading reviews requires the
 * `business.manage` scope AND, for anyone outside Google's original Google
 * My Business partner program, Google's manual approval of your OAuth
 * consent screen for that scope in production. This can take days/weeks
 * and isn't guaranteed — the same category of external dependency as Meta
 * App Review elsewhere in this codebase. Everything here is inert until
 * both `GOOGLE_BUSINESS_CLIENT_ID` + `GOOGLE_BUSINESS_CLIENT_SECRET` are
 * set AND Google has approved the scope for your OAuth client.
 */

const SCOPE = "https://www.googleapis.com/auth/business.manage";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleBusinessAppConfigured(): boolean {
  return (
    !!process.env.GOOGLE_BUSINESS_CLIENT_ID &&
    !!process.env.GOOGLE_BUSINESS_CLIENT_SECRET
  );
}

/**
 * The ONE OAuth redirect URI for the whole deployment — Google validates it
 * with an exact match against the OAuth client's registered list, so it must
 * be a single fixed value. The connecting sub-account travels in the signed
 * `state` instead (same pattern as metaRedirectUri).
 */
export function googleBusinessRedirectUri(): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/api/google-business/callback`;
}

export function buildGoogleBusinessOAuthUrl(opts: {
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_BUSINESS_CLIENT_ID ?? "",
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// CSRF state — HMAC-signed with the existing AUTOMATIONS_TOKEN_SECRET, same
// pattern as Meta's signMetaState/verifyMetaState.
// ---------------------------------------------------------------------------

function stateSecret(): string {
  return process.env.AUTOMATIONS_TOKEN_SECRET ?? "";
}

export function signGoogleBusinessState(
  subAccountId: string,
  nonce: string,
): string {
  const payload = `${subAccountId}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", stateSecret())
    .update(`gbpstate:${payload}`)
    .digest("hex");
  return `${payload}.${sig}`;
}

export function verifyGoogleBusinessState(
  state: string,
): { subAccountId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [subAccountId, nonce, sig] = parts;
  const expected = crypto
    .createHmac("sha256", stateSecret())
    .update(`gbpstate:${subAccountId}.${nonce}`)
    .digest("hex");
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  return { subAccountId };
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

/** Exchange the OAuth `code` for tokens. `refresh_token` is only returned on
 *  the FIRST consent (access_type=offline + prompt=consent forces this). */
export async function exchangeGoogleBusinessCode(
  code: string,
  redirectUri: string,
): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_BUSINESS_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      code,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ?? data.error ?? `Google token exchange failed (${res.status})`,
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  };
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshGoogleBusinessAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_BUSINESS_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ?? data.error ?? `Google token refresh failed (${res.status})`,
    );
  }
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  };
}
