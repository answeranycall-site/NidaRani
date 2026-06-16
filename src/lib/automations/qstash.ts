import "server-only";

import { Client, Receiver } from "@upstash/qstash";

/**
 * QStash thin wrapper. Two roles:
 *   1. publishStep()   — schedules a future POST against /api/automations/step
 *      (used by triggers + the step executor when chaining the next step).
 *   2. verifySignature() — wraps Upstash's Receiver to validate the
 *      Upstash-Signature header on inbound callback POSTs.
 *
 * If QStash isn't configured (no QSTASH_TOKEN), publishStep returns null and
 * the caller logs a graceful warning. That keeps local dev workable without
 * live QStash credentials, at the cost of automations not firing.
 */

let _client: Client | null = null;
let _receiver: Receiver | null = null;

function getClient(): Client | null {
  if (!process.env.QSTASH_TOKEN) return null;
  if (!_client) {
    // QSTASH_URL is region-specific (eu-central-1.upstash.io vs
    // us-east-1.upstash.io). The SDK default may not match the token's
    // region, so we pass it explicitly when set.
    const baseUrl = process.env.QSTASH_URL;
    _client = new Client({
      token: process.env.QSTASH_TOKEN,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  return _client;
}

function getReceiver(): Receiver | null {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current || !next) return null;
  if (!_receiver) {
    _receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    });
  }
  return _receiver;
}

export function qstashIsConfigured(): boolean {
  return !!getClient() && !!getReceiver();
}

interface PublishCallbackInput {
  /** Path on our app, e.g. "/api/automations/step" — gets appended to NEXT_PUBLIC_APP_URL. */
  pathname: string;
  /** Body POSTed to the callback. */
  body: Record<string, unknown>;
  /** Seconds to defer before the callback fires. 0 = fire immediately. */
  delaySeconds: number;
  /** QStash dedup id — underscores only, no colons. Reschedules pass a nonce-suffixed id. */
  deduplicationId: string;
}

interface PublishCallbackResult {
  messageId: string;
}

/**
 * Generic QStash publish helper — schedules a POST against any path on our
 * app. Used by the automations step executor and the website poll loop.
 *
 * Returns null if QStash isn't configured or the publish failed; callers
 * decide what to do (typically: mark the work item failed).
 */
export async function publishCallback(
  input: PublishCallbackInput,
): Promise<PublishCallbackResult | null> {
  const client = getClient();
  if (!client) return null;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    console.error("[qstash] NEXT_PUBLIC_APP_URL not set");
    return null;
  }

  try {
    const res = await client.publishJSON({
      url: `${baseUrl}${input.pathname}`,
      body: input.body,
      delay: Math.max(0, Math.floor(input.delaySeconds)),
      deduplicationId: input.deduplicationId,
    });
    return { messageId: res.messageId };
  } catch (err) {
    console.error("[qstash] publishCallback failed", err);
    return null;
  }
}

interface PublishStepInput {
  executionId: string;
  stepIndex: number;
  /** Seconds to defer before the callback fires. 0 = fire immediately. */
  delaySeconds: number;
  /**
   * Optional disambiguator appended to the deduplication id. The trigger
   * helper uses no nonce so retries inside the dedup window collapse;
   * legitimate reschedules (send-window deferral) pass a fresh nonce so
   * the second publish lands as a new message.
   */
  nonce?: string;
}

/**
 * Schedule a callback POST against /api/automations/step. Thin wrapper over
 * publishCallback — exists so the executor doesn't have to know the path.
 */
export async function publishStep(
  input: PublishStepInput,
): Promise<PublishCallbackResult | null> {
  return publishCallback({
    pathname: "/api/automations/step",
    body: { executionId: input.executionId, stepIndex: input.stepIndex },
    delaySeconds: input.delaySeconds,
    deduplicationId: input.nonce
      ? `${input.executionId}_${input.stepIndex}_${input.nonce}`
      : `${input.executionId}_${input.stepIndex}`,
  });
}

/**
 * Verify an inbound QStash callback's signature. Returns true if the body
 * matches the Upstash-Signature header.
 */
export async function verifyQStashSignature(
  signature: string,
  body: string,
): Promise<boolean> {
  const receiver = getReceiver();
  if (!receiver) return false;
  try {
    return await receiver.verify({ signature, body });
  } catch {
    return false;
  }
}
