import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { listRetellAgents, retellIsConfigured } from "@/lib/comms/retell";
import type { SubAccountDoc, TwilioPoolNumber } from "@/types";

/**
 * Lists every Retell agent on the account (shared Retell API key, not
 * scoped per sub-account — same "one key, agency-wide" model this
 * codebase uses for gitpage/Firecrawl), cross-referenced with which pool
 * numbers (if any) are currently bound to each one.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;

  if (!retellIsConfigured()) {
    return NextResponse.json({
      configured: false,
      agents: [],
      numbers: [],
    });
  }

  const [agentsResult, numbersSnap] = await Promise.all([
    listRetellAgents(),
    getAdminDb().collection(`subAccounts/${subAccountId}/twilioNumbers`).get(),
  ]);

  const numbers = numbersSnap.docs
    .map((d) => d.data() as TwilioPoolNumber)
    .filter((n) => n.enabled && !n.archivedAt)
    .map((n) => ({ id: n.id, e164: n.e164, label: n.label, retellAgentId: n.retellAgentId }));

  if (!agentsResult.ok) {
    return NextResponse.json(
      { configured: true, error: agentsResult.error, agents: [], numbers },
      { status: 502 },
    );
  }

  return NextResponse.json({
    configured: true,
    agents: agentsResult.agents,
    numbers,
  });
}
