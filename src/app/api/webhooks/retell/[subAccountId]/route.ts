import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handleVapiEndOfCall } from "@/lib/comms/voice/end-of-call";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Retell AI call-analyzed webhook (BETA — a separate voice provider from
 * the built-in Vapi Voice Agent; use this if you're running a Retell
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
 * Auth: HMAC-SHA256 signature in X-Retell-Signature, format
 * "v={timestampMs},d={hexDigest}" where
 * digest = HMAC-SHA256(rawBody + timestamp, RETELL_API_KEY) — must be the
 * API key with the "webhook" badge in the Retell dashboard, not just any
 * key. retell-sdk doesn't currently export a verify() helper (checked
 * v5.43.0), so this reimplements the documented algorithm directly per
 * docs.retellai.com/features/secure-webhook. A stale timestamp (>5 min)
 * is rejected as a replay-defense measure, same as the spec requires.
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

interface RetellTranscriptTurn {
  role?: string;
  content?: string;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

interface RetellCall {
  call_id?: string;
  direction?: "inbound" | "outbound";
  from_number?: string;
  to_number?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  disconnection_reason?: string;
  transcript_object?: RetellTranscriptTurn[];
  call_analysis?: {
    call_summary?: string;
    custom_analysis_data?: RetellCustomAnalysisData;
  };
  /** Custom metadata an operator could attach when placing an outbound
   *  call via Retell's API. Mirrors the pattern Vapi's outbound calls use
   *  (see createOutboundCall) — optional, only relevant for outbound. */
  metadata?: {
    direction?: string;
    contactId?: string;
    campaignId?: string;
  };
}

interface RetellWebhookBody {
  event?: string;
  call?: RetellCall;
}

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

function verifyRetellSignature(
  rawBody: string,
  apiKey: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const match = header.match(/^v=(\d+),d=(.+)$/);
  if (!match) return false;
  const [, timestampStr, digest] = match;
  const timestamp = Number(timestampStr);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() - timestamp) > SIGNATURE_MAX_AGE_MS
  ) {
    return false;
  }
  const expected = createHmac("sha256", apiKey)
    .update(rawBody + timestampStr)
    .digest("hex");
  if (expected.length !== digest.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(digest));
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Normalise Retell's transcript_object into our canonical shape (same
 *  as the Vapi route's extractTranscript). "agent" -> "assistant"; any
 *  other role is dropped. */
function extractTranscript(call: RetellCall): Array<{
  role: "assistant" | "user" | "system";
  content: string;
  secondsFromStart: number | null;
}> {
  const raw = call.transcript_object ?? [];
  const out: Array<{
    role: "assistant" | "user" | "system";
    content: string;
    secondsFromStart: number | null;
  }> = [];
  for (const turn of raw) {
    const role = (turn.role ?? "").toLowerCase();
    if (role !== "agent" && role !== "user") continue;
    const content = (turn.content ?? "").trim();
    if (!content) continue;
    const firstWordStart = turn.words?.[0]?.start;
    const secondsFromStart =
      typeof firstWordStart === "number" && typeof call.start_timestamp === "number"
        ? Math.max(0, Math.round((firstWordStart - call.start_timestamp) / 1000))
        : null;
    out.push({
      role: role === "agent" ? "assistant" : "user",
      content,
      secondsFromStart,
    });
  }
  return out;
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

  const call = body.call ?? {};
  const callId = asString(call.call_id);
  if (!callId) {
    return NextResponse.json({ error: "Missing call.call_id" }, { status: 400 });
  }

  const inbound = call.direction !== "outbound";
  const callerPhone = asString(inbound ? call.from_number : call.to_number);
  const toPhone = asString(inbound ? call.to_number : call.from_number);
  const durationSec =
    typeof call.start_timestamp === "number" &&
    typeof call.end_timestamp === "number"
      ? Math.max(0, Math.round((call.end_timestamp - call.start_timestamp) / 1000))
      : 0;

  const custom = call.call_analysis?.custom_analysis_data ?? {};

  try {
    const result = await handleVapiEndOfCall({
      subAccountId,
      payload: {
        callId,
        callerPhone,
        toPhone,
        durationSec,
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
        transcript: extractTranscript(call),
        direction:
          call.metadata?.direction === "outbound" || call.direction === "outbound"
            ? "outbound"
            : undefined,
        metaContactId: asString(call.metadata?.contactId),
        metaCampaignId: asString(call.metadata?.campaignId),
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
