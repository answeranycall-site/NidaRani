import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { attachRetellAgentToNumber, detachRetellAgentFromNumber } from "@/lib/comms/retell";
import type { SubAccountDoc, TwilioPoolNumber } from "@/types";

interface Body {
  agentId: string | null;
}

/**
 * Attach (or clear) a Retell agent for inbound-voice handling on one pool
 * number. Runs the full publish -> import/bind -> record sequence — see
 * `lib/comms/retell.ts::attachRetellAgentToNumber` for the step-by-step
 * breakdown returned to the caller.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; numberId: string }> },
) {
  const { id: subAccountId, numberId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;

  const numberSnap = await db
    .doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`)
    .get();
  if (!numberSnap.exists) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }
  const number = numberSnap.data() as TwilioPoolNumber;

  const result = body.agentId
    ? await attachRetellAgentToNumber({
        subAccountId,
        numberId,
        e164: number.e164,
        agentId: body.agentId,
      })
    : await detachRetellAgentFromNumber({ subAccountId, numberId, e164: number.e164 });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, steps: "steps" in result ? result.steps : undefined },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, steps: "steps" in result ? result.steps : undefined });
}
