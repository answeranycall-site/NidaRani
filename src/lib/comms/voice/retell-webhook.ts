import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared Retell AI webhook primitives — signature verification + payload
 * parsing — used by BOTH Retell webhook routes:
 *   - /api/webhooks/retell/[subAccountId] (client automations, feeds
 *     handleVapiEndOfCall)
 *   - /api/webhooks/retell/call-ended (Answer Any Call's own business
 *     line, simpler reconcile-Contact + log-activity shape)
 *
 * Kept in one place so the signature algorithm and payload shape are only
 * documented/implemented once. See docs.retellai.com/features/secure-webhook
 * for the verification spec and docs.retellai.com/api-references/get-call
 * for the call object's fields (the webhook embeds the same object).
 */

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * X-Retell-Signature format: "v={timestampMs},d={hexDigest}" where
 * digest = HMAC-SHA256(rawBody + timestamp, apiKey) — apiKey must be the
 * key with the "webhook" badge in the Retell dashboard, not just any key.
 * retell-sdk doesn't currently export a verify() helper (checked v5.43.0),
 * so this reimplements the documented algorithm directly. A stale
 * timestamp (>5 min) is rejected as a replay-defense measure per the spec.
 */
export function verifyRetellSignature(
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

export interface RetellTranscriptTurn {
  role?: string;
  content?: string;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

export interface RetellCall {
  call_id?: string;
  direction?: "inbound" | "outbound";
  from_number?: string;
  to_number?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  disconnection_reason?: string;
  /** Plain-text transcript. transcript_object is the structured turn-by-
   *  turn version, used by extractTranscriptTurns(). */
  transcript?: string;
  transcript_object?: RetellTranscriptTurn[];
  /** Populated once the call ends. Basic (non-multi-channel, non-scrubbed)
   *  recording — the other three variants (multi-channel / scrubbed) exist
   *  in Retell's API but aren't needed here. */
  recording_url?: string;
  call_analysis?: {
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
    /** Shape is whatever the operator configured under the agent's
     *  Post-Call Analysis settings in the Retell dashboard — the caller
     *  casts this to whatever fields it actually expects. */
    custom_analysis_data?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface RetellWebhookBody {
  event?: string;
  call?: RetellCall;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Normalise Retell's transcript_object into our canonical shape (matches
 *  the Vapi route's transcript shape). "agent" -> "assistant"; any other
 *  role is dropped. */
export function extractTranscriptTurns(call: RetellCall): Array<{
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

/** Duration in whole seconds from start/end epoch-ms timestamps, or 0 if
 *  either is missing. */
export function durationSecFromCall(call: RetellCall): number {
  return typeof call.start_timestamp === "number" &&
    typeof call.end_timestamp === "number"
    ? Math.max(0, Math.round((call.end_timestamp - call.start_timestamp) / 1000))
    : 0;
}
