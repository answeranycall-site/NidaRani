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
  "Thanks for letting us know — we're sorry it wasn't a great experience. Someone from our team will reach out shortly to make it right.";

/** Initial "how many stars" ask, sent instead of the direct link when the
 *  rating gate is on. Tags: {{firstName}} / {{businessName}}. */
export const DEFAULT_RATING_ASK_TEMPLATE =
  "Hi {{firstName}}, thanks for choosing {{businessName}}! On a scale of 1-5, how was your experience? Just reply with a number.";

/**
 * How long an "awaiting rating reply" flag stays live after a review request
 * goes out. A reply after this window is treated as ordinary chat instead of
 * a stale rating answer. 7 days comfortably covers a delayed reply without
 * risking a much-later unrelated text getting misread as a star rating.
 */
export const RATING_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
