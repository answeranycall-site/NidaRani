/**
 * Strips a UTF-8 BOM (U+FEFF) and surrounding whitespace from an env var
 * value. Vercel/Windows tooling can silently prepend a BOM when a secret is
 * piped in from a file or clipboard - the value still *looks* correct in
 * the dashboard, but strict format checks fail on it (e.g. Twilio's SDK
 * rejecting a BOM-prefixed accountSid with "accountSid must start with AC",
 * or a REST call returning 401 because the Basic Auth header was built from
 * the corrupted string). Same root cause CLAUDE.md documents for the
 * Firebase admin credentials - this is the reusable version of that fix.
 */
const BOM = String.fromCharCode(0xfeff);

export function cleanEnv(value: string | undefined | null): string {
  if (!value) return "";
  const noBom = value.startsWith(BOM) ? value.slice(BOM.length) : value;
  return noBom.trim();
}
