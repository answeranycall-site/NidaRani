/**
 * US area-code -> state lookup, plus a per-state list of area codes to
 * search when buying a new number for that state. Deliberately the same
 * data the operator's prior cold-outreach tooling used — not exhaustive of
 * every US area code, just the states that tool actually covered.
 */

export const AREA_CODE_TO_STATE: Record<string, string> = {
  "615": "TN", "629": "TN", "731": "TN", "865": "TN", "901": "TN", "423": "TN",
  "314": "MO", "417": "MO", "573": "MO", "636": "MO", "660": "MO", "816": "MO",
  "404": "GA", "470": "GA", "678": "GA", "706": "GA", "762": "GA", "770": "GA", "912": "GA",
  "214": "TX", "281": "TX", "346": "TX", "469": "TX", "512": "TX", "682": "TX",
  "713": "TX", "737": "TX", "817": "TX", "832": "TX", "903": "TX", "915": "TX",
  "936": "TX", "940": "TX", "956": "TX", "972": "TX",
  "205": "AL", "251": "AL", "256": "AL", "334": "AL", "659": "AL",
  "501": "AR", "479": "AR", "870": "AR", "327": "AR",
  "502": "KY", "270": "KY", "364": "KY", "606": "KY", "859": "KY",
  "601": "MS", "228": "MS", "662": "MS", "769": "MS",
  "704": "NC", "743": "NC", "828": "NC", "910": "NC", "919": "NC", "980": "NC", "984": "NC",
  "803": "SC", "843": "SC", "854": "SC", "864": "SC",
  "276": "VA", "434": "VA", "540": "VA", "571": "VA", "703": "VA", "757": "VA", "804": "VA",
  "305": "FL", "786": "FL", "813": "FL", "727": "FL",
  "213": "CA", "323": "CA", "415": "CA", "628": "CA",
  "206": "WA", "425": "WA",
  "303": "CO", "720": "CO", "970": "CO",
  "212": "NY", "646": "NY", "917": "NY", "718": "NY", "347": "NY", "929": "NY",
  "602": "AZ", "480": "AZ", "623": "AZ", "928": "AZ", "520": "AZ",
  "801": "UT", "385": "UT",
  "312": "IL", "773": "IL",
  "313": "MI", "248": "MI",
  "614": "OH", "380": "OH",
  "410": "MD", "443": "MD",
};

/** Per-state area codes to try (in order) when buying a new number for
 *  that state — mirrors `buyNumberForState_`'s STATE_AREA_CODES. */
export const STATE_AREA_CODES: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [ac, state] of Object.entries(AREA_CODE_TO_STATE)) {
    (out[state] ??= []).push(ac);
  }
  return out;
})();

export function areaCodeFromE164(e164: string): string {
  const digits = String(e164 || "").replace(/\D/g, "");
  return digits.length === 11 ? digits.slice(1, 4) : digits.slice(0, 3);
}

export function stateFromE164(e164: string): string | null {
  return AREA_CODE_TO_STATE[areaCodeFromE164(e164)] ?? null;
}

/**
 * Derive a US state abbreviation from a free-text address column, the same
 * heuristic the operator's prior tooling used: a two-letter state code
 * immediately before an optional trailing ZIP at the end of the string,
 * e.g. "123 Main St, Nashville, TN 37201" -> "TN".
 */
export function stateFromAddress(address: string): string | null {
  const match = String(address || "").match(/,\s*([A-Z]{2})\s*\d{0,5}\s*$/);
  return match ? match[1] : null;
}
