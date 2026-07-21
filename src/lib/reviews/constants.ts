/**
 * Shared (non-server) constants for the Google review-request feature, so the
 * server-only dispatcher AND the client settings UI can import them.
 */

/** Pre-filled SMS body. Tags: {{firstName}} / {{businessName}} / {{reviewUrl}}. */
export const DEFAULT_REVIEW_SMS_TEMPLATE =
  "Hi {{firstName}}, thanks for choosing {{businessName}}! If you have a moment, a quick Google review would mean a lot: {{reviewUrl}}";

export const DEFAULT_REVIEW_COOLDOWN_DAYS = 90;

/** Sent to a 1-3 rating-gate reply when the sub-account hasn't customized it. */
export const DEFAULT_INTERNAL_FEEDBACK_MESSAGE =
  "Oh, sorry to hear that. We will review your feedback and get back with you.";

/** Initial "how many stars" ask, sent instead of the direct link when the
 *  rating gate is on. Tags: {{firstName}} / {{businessName}}. */
export const DEFAULT_RATING_ASK_TEMPLATE =
  "Hi {{firstName}}, thanks for being our valued client at {{businessName}}! ⭐ How would you rate our service? Reply with 1, 2, 3, 4, or 5 stars.";

/**
 * How long an "awaiting rating reply" flag stays live after a review request
 * goes out. A reply after this window is treated as ordinary chat instead of
 * a stale rating answer. 7 days comfortably covers a delayed reply without
 * risking a much-later unrelated text getting misread as a star rating.
 */
export const RATING_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many consecutive ambiguous replies (no readable 1-5) the gate
 * tolerates before giving up — a typo'd first reply ("srry") followed by
 * the real answer 1-2 texts later still gets caught, instead of the gate
 * closing the instant the first reply doesn't parse.
 */
export const MAX_RATING_REPLY_ATTEMPTS = 3;

/**
 * How long a clean, unambiguous single-digit rating is held before it's
 * actually committed (Google link / apology sent) — gives a customer who
 * fires off a same-minute correction ("wait, 3 not 5") a chance to be
 * caught before the first reply commits. Implemented as a QStash-scheduled
 * callback (see api/webhooks/reviews/commit-rating), so nothing blocks the
 * inbound webhook itself.
 */
export const RATING_HOLD_WINDOW_SEC = 30;

/**
 * Review send channel:
 *  - "sms"               — free-form SMS.
 *  - "whatsapp_template" — approved WhatsApp template (compliant outside the 24h
 *                          window; needed for reliable auto-sends).
 *  - "whatsapp_manual"   — free-form WhatsApp, NO template — only works while the
 *                          customer's 24h window is open (e.g. they just messaged
 *                          you). Best used from the unified inbox.
 */
export type ReviewChannel = "sms" | "whatsapp_template" | "whatsapp_manual";

/** Map a stored channel (incl. the legacy 2-option "whatsapp") to a ReviewChannel. */
export function normalizeReviewChannel(
  raw: string | null | undefined,
): ReviewChannel {
  if (raw === "sms" || raw === "whatsapp_template" || raw === "whatsapp_manual") {
    return raw;
  }
  if (raw === "whatsapp") return "whatsapp_template"; // legacy value
  return "sms";
}

/** True for either WhatsApp mode. */
export function isWhatsappReviewChannel(ch: ReviewChannel): boolean {
  return ch === "whatsapp_template" || ch === "whatsapp_manual";
}
