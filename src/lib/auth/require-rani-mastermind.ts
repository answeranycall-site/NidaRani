import "server-only";

import { NextResponse } from "next/server";
import type { SubAccountDoc } from "@/types";

/**
 * Gate check for the whole "RANI MASTERMIND" bundle (Cold SMS number pool,
 * CSV import, bulk campaigns, Retell Voice Agent) — see
 * `SubAccountDoc.raniMastermindEnabledByAgency`'s doc comment for why it's
 * one gate for the whole bundle. Every route under `/api/sub-accounts/[id]
 * /twilio/numbers*`, `/api/sub-accounts/[id]/cold-sms/*`,
 * `/api/sub-accounts/[id]/retell/*`, and `/api/comms/sms/campaign/*` calls
 * this right after loading the sub-account doc.
 *
 * Returns a 403 NextResponse to short-circuit the caller when the gate is
 * off; returns null when it's fine to proceed.
 */
export function requireRaniMastermindGate(
  subAccount: SubAccountDoc | null | undefined,
): NextResponse | null {
  if (subAccount?.raniMastermindEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "This feature isn't enabled for this sub-account. Ask your agency owner to turn on RANI MASTERMIND from Manage.",
      },
      { status: 403 },
    );
  }
  return null;
}
