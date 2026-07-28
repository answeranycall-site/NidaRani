/**
 * Preset industry list for the Dashboard's Industry dropdown. Shared
 * between client + server so validation and the UI stay in sync.
 * `subAccount.industry` stores the raw string either way — a preset value
 * from this list, or any free-text value the operator typed after picking
 * "Other". The UI infers which state to show by checking membership here.
 */
export const INDUSTRY_OPTIONS: readonly string[] = [
  "Home Services (Plumbing, HVAC, Electrical)",
  "Construction / Contracting",
  "Cleaning Services",
  "Real Estate",
  "Legal",
  "Medical / Dental",
  "Salon / Spa / Beauty",
  "Fitness / Wellness",
  "Restaurant / Food Service",
  "Auto Repair / Detailing",
  "Pet Services",
  "Professional Services (Accounting, Consulting)",
  "Retail",
];

export const OTHER_INDUSTRY = "Other";
