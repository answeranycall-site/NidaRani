import "server-only";

import { NextResponse } from "next/server";
import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { executeStep } from "@/lib/automations/executor";

export const dynamic = "force-dynamic";

interface CallbackBody {
  executionId?: string;
  stepIndex?: number;
}

/**
 * QStash callback endpoint. Public (no Firebase Auth) — security comes from
 * verifying the Upstash-Signature header against the signing keys before
 * running anything.
 *
 * Returning 5xx triggers QStash to retry; 2xx and 4xx are terminal. Hard
 * errors return 500 so QStash retries; bad input returns 400 so QStash
 * doesn't.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured on this deployment." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 401 },
    );
  }

  let payload: CallbackBody;
  try {
    payload = JSON.parse(rawBody) as CallbackBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof payload.executionId !== "string" ||
    typeof payload.stepIndex !== "number"
  ) {
    return NextResponse.json(
      { error: "Body must include executionId (string) and stepIndex (number)" },
      { status: 400 },
    );
  }

  try {
    await executeStep({
      executionId: payload.executionId,
      stepIndex: payload.stepIndex,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Step execution failed";
    console.error("[automations/step] execution threw", err);
    // Return 500 so QStash retries this step.
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
