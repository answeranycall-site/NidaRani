/**
 * Merge-tag resolution for automation templates.
 *
 * Tags are resolved at send-time against the contact, sub-account, and
 * agency-owner snapshots loaded by the executor. Unknown tags resolve to
 * an empty string (don't leak `{{...}}` placeholders into outbound copy).
 *
 * Supported tags:
 *   {{contact.firstName}}, {{contact.lastName}}, {{contact.email}}, {{contact.phone}}
 *   {{owner.firstName}},   {{owner.email}}
 *   {{workspace.name}}
 *   {{bookingLink}}        — sub-account's configured Calendly / Cal.com /
 *                            TidyCal URL. Empty string when not set.
 *   {{paymentLink}}        — sub-account's configured payment URL (Stripe
 *                            Payment Link, PayPal.me, etc). Empty string
 *                            when not set.
 *   {{booking.time}}, {{booking.title}}, {{booking.rescheduleLink}} — the
 *                            THIS-appointment fields, only populated on a
 *                            workflow enrolled via the `booking.created`
 *                            trigger (native Booking Pages feature, not the
 *                            `bookingLink` above). Empty string otherwise.
 *   {{industry}}           — sub-account's configured industry (Dashboard).
 *                            Empty string when not set.
 *   {{ltv}}                — sub-account's configured customer lifetime
 *                            value (Dashboard), formatted as a dollar
 *                            figure (e.g. "$2,500"). Empty string when not set.
 *   {{unsubscribeLink}}    — required in email bodies.
 *
 * Per-type slugged booking tags ({{bookingLink:30min}}) are reserved for a
 * future multi-link booking integration.
 */

export interface MergeTagSubject {
  contact: {
    name: string;
    email: string;
    phone: string;
  };
  owner: {
    displayName: string;
    email: string;
  };
  workspace: {
    name: string;
  };
  /**
   * Sub-account's booking-page URL, surfaced via {{bookingLink}}. Empty
   * string when the sub-account hasn't set one — tag resolves to empty
   * rather than leaking the raw `{{bookingLink}}` placeholder.
   */
  bookingLink: string;
  /** Sub-account's configured payment URL, surfaced via {{paymentLink}}.
   *  Empty string when not set. */
  paymentLink: string;
  /**
   * THIS-appointment fields, only present when the workflow run's trigger
   * was `booking.created` (native Booking Pages feature — see
   * lib/booking/lifecycle.ts::fireBookingTrigger). Null on every other
   * trigger type, so {{booking.*}} tags resolve to empty rather than
   * leaking the raw placeholder.
   */
  booking?: { time: string; title: string; rescheduleLink: string } | null;
  /** Sub-account's configured industry, surfaced via {{industry}}. Empty
   *  string when not set. */
  industry: string;
  /** Sub-account's configured customer lifetime value in whole dollars,
   *  surfaced via {{ltv}} formatted as e.g. "$2,500". Null/0 resolves to
   *  empty string. */
  ltv: number | null;
  /** Pre-built fully-qualified unsubscribe URL. Empty string for SMS templates. */
  unsubscribeLink: string;
}

const TAG_RE = /\{\{\s*([a-zA-Z0-9_.:-]+)\s*\}\}/g;

// Mirrors lib/leads/lead-label.ts::isSystemLeadLabel — duplicated (rather
// than imported) because that module is server-only and this file is
// imported by a client component (components/automations/template-editor.tsx).
const SYSTEM_LEAD_LABELS = ["New call lead", "New chat lead", "New SMS lead"];

/** Prefix-aware, because the label carries a phone suffix whenever the
 *  number is known: "New SMS lead (…4821)". */
function isSystemLeadLabel(trimmed: string): boolean {
  return SYSTEM_LEAD_LABELS.some(
    (label) => trimmed === label || trimmed.startsWith(`${label} (`),
  );
}

/** First word of a name, for {{contact.firstName}}. Falls back to "there"
 *  when the contact has no real name on file — either genuinely blank, or
 *  one of the auto-generated "New {X} lead" placeholders stamped on an
 *  anonymous lead — so a template reads "Hi there," instead of "Hi ," or
 *  "Hi New," (the first word of "New SMS lead"). */
function firstWord(s: string | null | undefined): string {
  const trimmed = (s ?? "").trim();
  if (!trimmed || isSystemLeadLabel(trimmed)) return "there";
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

function lastWord(s: string | null | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  const space = trimmed.lastIndexOf(" ");
  return space === -1 ? "" : trimmed.slice(space + 1);
}

export function resolveMergeTags(
  body: string,
  subject: MergeTagSubject,
): string {
  return body.replace(TAG_RE, (_match, tag: string) => {
    switch (tag) {
      case "contact.firstName":
        return firstWord(subject.contact.name);
      case "contact.lastName":
        return lastWord(subject.contact.name);
      case "contact.email":
        return subject.contact.email ?? "";
      case "contact.phone":
        return subject.contact.phone ?? "";
      case "owner.firstName":
        return firstWord(subject.owner.displayName);
      case "owner.email":
        return subject.owner.email ?? "";
      case "workspace.name":
        return subject.workspace.name ?? "";
      case "bookingLink":
        return subject.bookingLink ?? "";
      case "paymentLink":
        return subject.paymentLink ?? "";
      case "booking.time":
        return subject.booking?.time ?? "";
      case "booking.title":
        return subject.booking?.title ?? "";
      case "booking.rescheduleLink":
        return subject.booking?.rescheduleLink ?? "";
      case "industry":
        return subject.industry ?? "";
      case "ltv":
        return subject.ltv ? `$${subject.ltv.toLocaleString("en-US")}` : "";
      case "unsubscribeLink":
        return subject.unsubscribeLink ?? "";
      default:
        // Unknown / deferred tags (e.g. per-type slugged booking links like
        // bookingLink:30min). Surface as empty rather than leak the raw
        // token into outbound copy.
        return "";
    }
  });
}

/**
 * The list of tags surfaced in the template editor's "Insert" picker. v2 will
 * extend this when booking links land.
 */
export const SUPPORTED_TAGS_EMAIL: ReadonlyArray<{ tag: string; description: string }> = [
  { tag: "contact.firstName", description: "Contact's first name" },
  { tag: "contact.lastName", description: "Contact's last name" },
  { tag: "contact.email", description: "Contact's email address" },
  { tag: "contact.phone", description: "Contact's phone number" },
  { tag: "owner.firstName", description: "Agency owner's first name" },
  { tag: "owner.email", description: "Agency owner's email" },
  { tag: "workspace.name", description: "Sub-account name" },
  { tag: "bookingLink", description: "Booking page URL (set in Automations → Settings)" },
  { tag: "paymentLink", description: "Payment URL (set in Settings → Messaging)" },
  { tag: "booking.time", description: "This appointment's date/time (booking.created trigger only)" },
  { tag: "booking.title", description: "This appointment's title (booking.created trigger only)" },
  { tag: "booking.rescheduleLink", description: "Link to reschedule/cancel THIS appointment (booking.created trigger only)" },
  { tag: "industry", description: "Sub-account's industry (set on Dashboard)" },
  { tag: "ltv", description: "Customer lifetime value, e.g. \"$2,500\" (set on Dashboard)" },
  { tag: "unsubscribeLink", description: "Per-contact unsubscribe URL (required in email)" },
];

export const SUPPORTED_TAGS_SMS: ReadonlyArray<{ tag: string; description: string }> = [
  { tag: "contact.firstName", description: "Contact's first name" },
  { tag: "contact.lastName", description: "Contact's last name" },
  { tag: "owner.firstName", description: "Agency owner's first name" },
  { tag: "workspace.name", description: "Sub-account name" },
  { tag: "bookingLink", description: "Booking page URL (set in Automations → Settings)" },
  { tag: "paymentLink", description: "Payment URL (set in Settings → Messaging)" },
  { tag: "booking.time", description: "This appointment's date/time (booking.created trigger only)" },
  { tag: "booking.title", description: "This appointment's title (booking.created trigger only)" },
  { tag: "booking.rescheduleLink", description: "Link to reschedule/cancel THIS appointment (booking.created trigger only)" },
  { tag: "industry", description: "Sub-account's industry (set on Dashboard)" },
  { tag: "ltv", description: "Customer lifetime value, e.g. \"$2,500\" (set on Dashboard)" },
];

/**
 * Validate an email-template body. Returns null if valid, an error string
 * otherwise. Required: must contain {{unsubscribeLink}} somewhere.
 */
export function validateEmailBody(body: string): string | null {
  if (!body.includes("{{unsubscribeLink}}")) {
    return "Email body must include {{unsubscribeLink}} somewhere.";
  }
  return null;
}

/**
 * Reject per-type slugged booking tags ({{bookingLink:30min}}) — the bare
 * {{bookingLink}} is now supported (resolves to the sub-account's URL),
 * but slug variants are reserved for a future multi-link integration.
 * Surfaces a clear error rather than silently resolving the tag to empty.
 */
export function validateNoBookingTags(body: string): string | null {
  const matches = body.match(/\{\{\s*bookingLink:[a-z0-9-]+\s*\}\}/g);
  if (matches && matches.length > 0) {
    return `Slugged booking tags aren't supported yet: ${matches.join(", ")}. Use {{bookingLink}} for the sub-account's default booking URL.`;
  }
  return null;
}
