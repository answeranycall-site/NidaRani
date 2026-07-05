import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-contact review-link click-tracking tokens. Same shape as
 * lib/automations/unsubscribe-token.ts:
 *
 *   `${contactId}.${HMAC-SHA256(contactId, AUTOMATIONS_TOKEN_SECRET)}`
 *
 * The actual Google review URL is never texted directly — only this
 * tracking link — so /api/r/[token] can stamp "they clicked" before
 * redirecting. The destination isn't encoded in the token; the redirect
 * route looks up the CURRENT googleReviewConfig.reviewUrl live off the
 * contact's sub-account, so an operator changing the review link later
 * doesn't strand already-sent texts pointing at a stale token.
 *
 * Rotating AUTOMATIONS_TOKEN_SECRET invalidates every outstanding link,
 * same tradeoff as the unsubscribe token.
 */

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "AUTOMATIONS_TOKEN_SECRET is not set (or too short). Generate one with `openssl rand -base64 32`.",
    );
  }
  return s;
}

export function signReviewClickToken(contactId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(contactId)) {
    throw new Error("Unexpected contactId format for review click token");
  }
  const sig = createHmac("sha256", getSecret()).update(contactId).digest("hex");
  return `${contactId}.${sig}`;
}

/**
 * Returns the contactId if the token is valid, or null otherwise. Uses a
 * timing-safe compare to thwart token-recovery via response-time analysis.
 */
export function verifyReviewClickToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const contactId = token.slice(0, dot);
  let expected: string;
  try {
    expected = signReviewClickToken(contactId);
  } catch {
    return null;
  }
  if (token.length !== expected.length) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? contactId : null;
}

/**
 * Build the tracking URL to text instead of the raw Google review link.
 * Empty string when NEXT_PUBLIC_APP_URL isn't configured — the template
 * still renders (just with a broken link) rather than throwing mid-send.
 */
export function buildReviewClickUrl(contactId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/r/${signReviewClickToken(contactId)}`;
}
