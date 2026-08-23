import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { autoConfigureInboundWebhook } from "@/lib/comms/twilio-config";
import { attachRetellAgentToNumber } from "@/lib/comms/retell";
import type { SubAccountDoc, TwilioConfig, TwilioPoolNumber } from "@/types";

/**
 * Re-points a number's SMS webhook at our inbound-SMS route (always the
 * correct value regardless of anything else). If the number has a Retell
 * agent assigned, also re-runs the Retell attach sequence so its Voice URL
 * gets pointed back at Retell's SIP trunk — the same drift-repair logic,
 * just for the voice side. If no Retell agent is assigned, voice is left
 * alone; there's no single "correct" default to force onto a number the
 * operator hasn't opted into voice handling for.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; numberId: string }> },
) {
  const { id: subAccountId, numberId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const [subSnap, numberSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db.doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`).get(),
  ]);
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;
  if (!numberSnap.exists) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }
  const number = numberSnap.data() as TwilioPoolNumber;
  const subAccount = subSnap.data() as SubAccountDoc | undefined;
  const cfg = (subAccount?.twilioConfig as TwilioConfig | undefined) ?? null;
  if (!cfg?.accountSid || !cfg.authToken) {
    return NextResponse.json(
      { error: "Twilio credentials not configured for this sub-account." },
      { status: 400 },
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
  const webhookUrl = base ? `${base}/api/webhooks/twilio/inbound` : "";
  const smsResult = webhookUrl
    ? await autoConfigureInboundWebhook({
        accountSid: cfg.accountSid,
        authToken: cfg.authToken,
        fromNumber: number.e164,
        webhookUrl,
      })
    : { ok: false, error: "NEXT_PUBLIC_APP_URL is not set on this deployment." };

  let voiceResult: { ok: boolean; error: string | null } = { ok: true, error: null };
  if (number.retellAgentId) {
    voiceResult = await attachRetellAgentToNumber({
      subAccountId,
      numberId,
      e164: number.e164,
      agentId: number.retellAgentId,
    });
  }

  return NextResponse.json({
    ok: smsResult.ok,
    smsFixed: smsResult.ok,
    smsError: smsResult.error,
    voiceFixed: voiceResult.ok,
    voiceError: voiceResult.error,
  });
}
