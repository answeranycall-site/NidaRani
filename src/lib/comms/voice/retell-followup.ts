/**
 * Shared (non-server) constants for the "more info to get started"
 * text-back for Answer Any Call's own Retell agent — sent from
 * /api/webhooks/retell/send-demo-info, which the agent calls mid-call (its
 * `send_demo_info` custom function) right after delivering its closing
 * line. Customizable at Settings → Messaging → Retell voice follow-up.
 * No server-only imports here (pure constants + string ops) so both the
 * server route and the client settings UI can import it directly.
 */
export const DEFAULT_RETELL_DEMO_INFO_TEMPLATE =
  "Thanks for calling {{businessName}}! Here's how to get started: book your Free Strategy Call at {{bookingLink}}, or just reply here with any questions.";

/**
 * Fallback for a call that ended (hangup, disconnect) before the agent
 * reached its scripted closing line — so send_demo_info never fired and
 * the caller never heard the "I'm sending you a text" promise. Distinct
 * tone from the demo-info message on purpose: this caller didn't get a
 * pitch, so it reads as a light re-open rather than "here's what we
 * discussed."
 */
export const DEFAULT_RETELL_QUICK_HANGUP_TEMPLATE =
  "Hey, looks like that call cut out quick! If you're curious how {{businessName}} helps businesses stop missing leads, just reply here or give us a call back anytime.";

/** Fill {{firstName}} / {{businessName}} / {{bookingLink}} into a Retell
 *  follow-up template. {{bookingLink}} resolves to the sub-account's
 *  configured booking link (Settings → Messaging → Booking link) — empty
 *  string when unset, same convention as the other {{bookingLink}} uses
 *  (send_sms, broadcasts, etc.) in lib/automations/merge-tags.ts. */
export function renderRetellFollowUp(
  template: string,
  vars: { firstName: string; businessName: string; bookingLink?: string },
): string {
  return template
    .replaceAll("{{firstName}}", vars.firstName)
    .replaceAll("{{businessName}}", vars.businessName)
    .replaceAll("{{bookingLink}}", vars.bookingLink ?? "");
}
