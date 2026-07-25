import "server-only";

/**
 * The "more info to get started" text-back for Answer Any Call's own
 * Retell agent — sent from /api/webhooks/retell/send-demo-info, which the
 * agent calls mid-call (its `send_demo_info` custom function) right after
 * delivering its closing line. Customizable at Settings → Messaging →
 * Retell voice follow-up.
 */
export const DEFAULT_RETELL_DEMO_INFO_TEMPLATE =
  "Thanks for calling {{businessName}}! Here's how to get started: book your Free Strategy Call at https://answeranycall.com, or just reply here with any questions.";

/** Fill {{firstName}} / {{businessName}} into the demo-info template. */
export function renderRetellFollowUp(
  template: string,
  vars: { firstName: string; businessName: string },
): string {
  return template
    .replaceAll("{{firstName}}", vars.firstName)
    .replaceAll("{{businessName}}", vars.businessName);
}
