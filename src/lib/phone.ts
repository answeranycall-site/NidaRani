import "server-only";

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * `contact.phone` is free text — the operator, a CSV import, or a public
 * form can produce it in any format (with or without a country code, with
 * dashes/parens/spaces). Inbound channels (Twilio SMS/WhatsApp, Vapi voice,
 * form submissions) always hand us a caller/sender number in strict E.164,
 * so an exact-equality match against `contact.phone` misses every contact
 * whose number wasn't typed in that exact format — which in practice is
 * most of them.
 *
 * Generates the handful of formats an operator plausibly typed for the
 * same number, so callers can match with a Firestore `in` query instead of
 * a single `==`. Doesn't rewrite or normalize the stored value itself —
 * this only widens what gets searched for.
 *
 * `defaultCountry` is only needed when `value` might lack a leading "+"
 * (e.g. a visitor-typed public form field) — libphonenumber-js can't parse
 * a bare national number without a country hint. Webhook-sourced numbers
 * (Twilio/Vapi) are always strict E.164 and don't need it.
 */
export function phoneMatchVariants(
  value: string,
  defaultCountry?: CountryCode,
): string[] {
  const variants = new Set<string>([value]);
  const parsed = parsePhoneNumberFromString(value, defaultCountry);
  if (parsed) {
    variants.add(parsed.number); // canonical E.164
    variants.add(parsed.number.replace(/^\+/, "")); // no leading +
    variants.add(parsed.nationalNumber); // digits only, no country code
    variants.add(parsed.formatNational()); // e.g. "(615) 796-8687"
    variants.add(parsed.formatNational().replace(/[\s()]/g, "")); // "615-796-8687"
    variants.add(parsed.formatInternational()); // e.g. "+1 615 796 8687"
  }
  // Firestore `in` queries cap at 30 values — comfortably more than we'll
  // ever generate here.
  return Array.from(variants);
}
