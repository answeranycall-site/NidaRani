import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { sendSmsForSubAccount, subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import {
  DEFAULT_RETELL_DEMO_INFO_TEMPLATE,
  renderRetellFollowUp,
} from "@/lib/comms/voice/retell-followup";
import { asString, verifyRetellSignature } from "@/lib/comms/voice/retell-webhook";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Retell custom-function target for `send_demo_info` — the AI agent on
 * Answer Any Call's own business line calls this itself, mid-call, right
 * after delivering its scripted closing line ("I'm sending you a text
 * right now..."). Fires immediately rather than waiting for the
 * call_analyzed post-call webhook (30-90s later), matching what the agent
 * already promises out loud.
 *
 * Fixed-target route, same shape as call-ended: always targets
 * RETELL_OWN_SUBACCOUNT_ID, not a general per-tenant feature.
 *
 * Retell's custom-function payload can arrive in two shapes depending on
 * the function's "Payload: args only" setting in the dashboard:
 *   OFF (default): { name, call: {...}, args: { ... } }
 *   ON:            { ...args fields at the top level }
 * We don't know which was picked, or the exact parameter name used for the
 * phone number, so both the wrapper shape and several common key names are
 * accepted defensively. Falls back to the call object's own from_number
 * (caller ID) if no usable arg is found.
 */

const PHONE_ARG_KEYS = [
  "phone_number",
  "phone",
  "to",
  "caller_phone",
  "number",
] as const;

interface RetellFunctionCall {
  call_id?: string;
  from_number?: string;
  to_number?: string;
  direction?: "inbound" | "outbound";
}

interface RetellFunctionBody {
  name?: string;
  call?: RetellFunctionCall;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

function extractPhone(body: RetellFunctionBody): string | null {
  const args = body.args ?? body;
  for (const key of PHONE_ARG_KEYS) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const call = body.call;
  if (call) {
    const inbound = call.direction !== "outbound";
    const fallback = inbound ? call.from_number : call.to_number;
    if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  }
  return null;
}

async function claimCall(subAccountId: string, callId: string): Promise<boolean> {
  const ref = getAdminDb().doc(
    `subAccounts/${subAccountId}/retellDemoInfoClaims/${callId}`,
  );
  try {
    return await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { callId, createdAt: FieldValue.serverTimestamp() });
      return true;
    });
  } catch (err) {
    console.warn("[retell/send-demo-info] claim transaction failed", err);
    return true; // fail open — a rare duplicate beats dropping the text
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  const subAccountId = process.env.RETELL_OWN_SUBACCOUNT_ID?.trim();
  if (!apiKey || !subAccountId) {
    return NextResponse.json(
      {
        error:
          "Retell own-business webhook isn't configured — set RETELL_API_KEY and RETELL_OWN_SUBACCOUNT_ID.",
      },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-retell-signature");
  if (!verifyRetellSignature(rawBody, apiKey, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: RetellFunctionBody;
  try {
    body = JSON.parse(rawBody) as RetellFunctionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const callId = asString(body.call?.call_id) ?? `no-call-id-${Date.now()}`;
  const fresh = await claimCall(subAccountId, callId);
  if (!fresh) {
    return NextResponse.json({ status: "already_sent" });
  }

  const phone = extractPhone(body);
  if (!phone) {
    console.warn("[retell/send-demo-info] no phone number in function args or call object");
    return NextResponse.json(
      { status: "error", message: "No phone number provided." },
      { status: 200 },
    );
  }

  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    console.error(
      `[retell/send-demo-info] RETELL_OWN_SUBACCOUNT_ID=${subAccountId} doesn't exist`,
    );
    return NextResponse.json({ status: "error", message: "sub-account not found" });
  }
  const sa = saSnap.data() as SubAccountDoc;

  if (!subAccountTwilioIsConfigured(sa.twilioConfig)) {
    return NextResponse.json({
      status: "error",
      message: "No dedicated Twilio number configured.",
    });
  }

  try {
    const reconciled = await reconcileContactFromCapture({
      agencyId: sa.agencyId,
      subAccountId,
      existingContactId: null,
      pageUrl: null,
      source: "retell-call",
      matchStrategy: "phone-first",
      capture: { name: null, email: null, phone },
    });
    const contactId = reconciled?.contactId ?? null;

    const profileSnap = await db
      .doc(`subAccounts/${subAccountId}/aiAgent/profile`)
      .get();
    const businessName =
      asString(profileSnap.data()?.businessName as string | undefined) ||
      sa.name ||
      "us";
    const template =
      sa.retellConfig?.demoInfoTemplate?.trim() ||
      DEFAULT_RETELL_DEMO_INFO_TEMPLATE;
    const messageBody = renderRetellFollowUp(template, {
      firstName: "there",
      businessName,
      bookingLink: sa.bookingLink ?? "",
    });

    const sendResult = await sendSmsForSubAccount({
      subAccountId,
      subAccount: sa,
      to: phone,
      body: messageBody,
    });

    if (sendResult.mode === "dedicated" && contactId) {
      await db
        .collection(`contacts/${contactId}/messages`)
        .doc(sendResult.sid)
        .set({
          agencyId: sa.agencyId,
          subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body: messageBody,
          from: sendResult.from,
          to: phone,
          twilioMessageSid: sendResult.sid,
          sentByUid: "retell-send-demo-info",
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
      await upsertConversationForMessage({
        contactId,
        subAccountId,
        agencyId: sa.agencyId,
        contactName: phone,
        contactPhone: phone,
        channel: "sms",
        direction: "outbound",
        body: messageBody,
      });
    }

    return NextResponse.json({ status: "sent" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[retell/send-demo-info] failed: ${msg}`);
    return NextResponse.json({ status: "error", message: msg });
  }
}
