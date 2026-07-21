import "server-only";

import { NextResponse } from "next/server";
import {
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendAndPersistReply } from "@/lib/comms/ai/respond";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Fires `AiChannelConfig.replyDelaySec` seconds after `maybeRespondWithAi`
 * generated a reply, to actually send it — a purely cosmetic "typing
 * delay" so the bot doesn't reply the instant a message arrives. Public
 * path; security is the Upstash signature (same model as
 * /api/workflows/step). The subAccount doc is re-read fresh here rather
 * than serialized into the QStash payload, so a mid-delay Twilio/creds
 * change is picked up instead of using a stale snapshot.
 */

interface DelayedSendPayload {
  subAccountId?: string;
  agencyId?: string;
  contactId?: string;
  contactName?: string;
  contactPhone?: string;
  channelId?: "sms" | "whatsapp";
  replyText?: string;
  model?: string;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: DelayedSendPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    subAccountId,
    agencyId,
    contactId,
    contactName,
    contactPhone,
    channelId,
    replyText,
    model,
    totalTokens,
    promptTokens,
    completionTokens,
  } = payload;

  if (
    !subAccountId ||
    !contactId ||
    !contactPhone ||
    !replyText ||
    (channelId !== "sms" && channelId !== "whatsapp")
  ) {
    return NextResponse.json(
      { error: "Malformed delayed-send payload" },
      { status: 400 },
    );
  }

  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    // Sub-account gone since this was scheduled — nothing to send to.
    return NextResponse.json({ ok: true, skipped: "sub_account_not_found" });
  }
  const subAccount = saSnap.data() as SubAccountDoc;

  const result = await sendAndPersistReply({
    subAccountId,
    subAccount,
    agencyId: agencyId ?? subAccount.agencyId,
    contactId,
    contactName: contactName ?? "",
    contactPhone,
    channelId,
    replyText,
    model: model ?? "unknown",
    totalTokens: totalTokens ?? 0,
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
  });

  if (!result.ok) {
    // Logged inside sendAndPersistReply already. Return 200 regardless —
    // this is a best-effort send, not something QStash should retry-storm.
    return NextResponse.json({ ok: false, error: result.error });
  }
  return NextResponse.json({ ok: true, sid: result.sid });
}
