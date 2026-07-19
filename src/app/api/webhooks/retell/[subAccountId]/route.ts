import "server-only";

import { NextResponse } from "next/server";
import { handleVapiEndOfCall } from "@/lib/comms/voice/end-of-call";
import {
  asBool,
  asString,
  durationSecFromCall,
  extractTranscriptTurns,
  verifyRetellSignature,
  type RetellCall,
  type RetellWebhookBody,
} from "@/lib/comms/voice/retell-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Retell AI call-analyzed webhook (BETA — a separate voice provider from
 * the built-in Vapi Voice Agent; use this if a CLIENT is running a Retell
 * agent instead of/alongside Vapi). Retell fires three events per call to
 * the same "Agent Level Webhook URL" — call_started, call_ended,
 * call_analyzed — but only call_analyzed carries `call.call_analysis`
 * (summary + custom extraction), so the other two are quietly accepted
 * and ignored.
 *
 * Reuses the SAME Contact-reconciliation + Task + escalation-email +
 * voiceCalls-summary pipeline the built-in Vapi Voice Agent uses
 * (handleVapiEndOfCall) — its payload shape is provider-agnostic, so a
 * Retell call gets identical operator-console treatment (AI Agents →
 * Voice → Calls) as a Vapi one, without a second pipeline to maintain.
 *
 * NOT to be confused with /api/webhooks/retell/call-ended — that's the
 * separate, fixed-target route for Answer Any Call's OWN business line,
 * which logs a single Contact activity instead of the full voiceCalls
 * pipeline. Both share signature verification + payload parsing from
 * lib/comms/voice/retell-webhook.ts.
 */

interface RetellCustomAnalysisData {
  /** Field names an operator must configure under the agent's Post-Call
   *  Analysis settings in the Retell dashboard for this route to extract
   *  anything useful — these exact keys, not arbitrary ones. */
  name?: string;
  email?: string;
  callback_requested?: boolean;
  interested?: boolean;
  interest_reason?: string;
  reason?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "RETELL_API_KEY is not configured on this deployment" },
      { status: 503 },
    );
  }

  // Signature verification needs the RAW body string — parsing first and
  // re-serializing would produce different bytes and always fail.
  const rawBody = await request.text();
  const signature = request.headers.get("x-retell-signature");
  if (!verifyRetellSignature(rawBody, apiKey, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const { subAccountId } = await ctx.params;

  let body: RetellWebhookBody;
  try {
    body = JSON.parse(rawBody) as RetellWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.event !== "call_analyzed") {
    // call_started / call_ended fire before analysis is ready (Retell
    // sends call_analyzed 30-90s later) — quietly accept and wait.
    return NextResponse.json({ ok: true, ignored: body.event ?? "unknown" });
  }

  const call: RetellCall = body.call ?? {};
  const callId = asString(call.call_id);
  if (!callId) {
    return NextResponse.json({ error: "Missing call.call_id" }, { status: 400 });
  }

  const inbound = call.direction !== "outbound";
  const callerPhone = asString(inbound ? call.from_number : call.to_number);
  const toPhone = asString(inbound ? call.to_number : call.from_number);
  const custom = (call.call_analysis?.custom_analysis_data ??
    {}) as RetellCustomAnalysisData;

  try {
    const result = await handleVapiEndOfCall({
      subAccountId,
      payload: {
        callId,
        callerPhone,
        toPhone,
        durationSec: durationSecFromCall(call),
        summary: asString(call.call_analysis?.call_summary),
        endedReason: asString(call.disconnection_reason),
        extracted: {
          name: asString(custom.name),
          email: asString(custom.email),
          phone: null,
          callbackRequested: asBool(custom.callback_requested),
          interested: asBool(custom.interested),
          interestReason: asString(custom.interest_reason),
          reason: asString(custom.reason),
        },
        transcript: extractTranscriptTurns(call),
        direction: call.direction === "outbound" ? "outbound" : undefined,
        metaContactId: asString(
          (call.metadata as { contactId?: string } | undefined)?.contactId,
        ),
        metaCampaignId: asString(
          (call.metadata as { campaignId?: string } | undefined)?.campaignId,
        ),
      },
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[retell/webhook] handler failed sa=${subAccountId}: ${msg}`);
    // Still 200 — a retry would just duplicate the Task/email, same
    // rationale as the Vapi route.
    return NextResponse.json({ ok: false, error: msg });
  }
}
