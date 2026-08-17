import "server-only";

import { NextResponse } from "next/server";
import {
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { deliverPooledSms } from "@/lib/comms/sms-pool";

export const dynamic = "force-dynamic";

/**
 * Number-pool SMS delivery worker — QStash callback that actually sends one
 * `smsOutbox` entry once its reserved rate-limit slot arrives. Public path;
 * security is the Upstash signature. `deliverPooledSms` is idempotent
 * (claims the outbox doc via a transaction before sending), so this is safe
 * to fire even when the inline delivery path in `enqueuePooledSms` already
 * handled it — this callback is the durability safety net, not the only
 * delivery path. 5xx → QStash retries; 2xx/4xx are terminal.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json({ error: "QStash is not configured." }, { status: 503 });
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { outboxId?: string; subAccountId?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof payload.outboxId !== "string" || typeof payload.subAccountId !== "string") {
    return NextResponse.json(
      { error: "Body must include outboxId + subAccountId" },
      { status: 400 },
    );
  }

  const result = await deliverPooledSms(payload.subAccountId, payload.outboxId);
  if (!result.ok) {
    console.error(`[sms/pool-send-step] delivery failed: ${result.error}`);
    // Terminal, not retried — a failed Twilio send (bad number, disabled
    // account, etc.) won't succeed on retry either, and deliverPooledSms
    // already marked the outbox doc "failed" for the operator to see.
    return NextResponse.json({ error: result.error }, { status: 200 });
  }
  return NextResponse.json({ ok: true, sid: result.sid });
}
