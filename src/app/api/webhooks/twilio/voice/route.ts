import "server-only";

import { NextResponse } from "next/server";
import twilio from "twilio";
import {
  DEFAULT_MCTB_RING_TIMEOUT_SEC,
  handleMissedCall,
  normalisePhone,
  resolveVoiceRoute,
} from "@/lib/comms/missed-call";

export const dynamic = "force-dynamic";

/**
 * Missed Call Text Back — the inbound VOICE webhook.
 *
 * Twilio hits this when a call arrives on a sub-account's dedicated number
 * (only sub-accounts with MCTB enabled point their Voice URL here). We return
 * TwiML that forwards the call to the business's real phone with a ring
 * timeout. Twilio then calls the `action` URL (/voice/status) with the dial
 * result — if it went unanswered, that endpoint fires the text-back.
 *
 * Mirrors the inbound-SMS webhook's routing + signature model. Always returns
 * 200 TwiML so Twilio doesn't retry-storm; a number that isn't MCTB-routed
 * gets a bare <Response/> (the call simply ends — we only ever own the Voice
 * URL when the operator opted in).
 */

function xml(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function statusCallbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/voice/status`;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const to = normalisePhone((params["To"] as string | undefined) ?? "");
  const from = (params["From"] as string | undefined) ?? "";

  const route = await resolveVoiceRoute(to);
  if (!route) {
    // Not an MCTB number (or MCTB was turned off) — end the call cleanly.
    return xml(EMPTY);
  }

  // Verify Twilio's signature against the sub-account's auth token.
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return xml(EMPTY);
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const url = new URL(request.url);
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}`;
  const valid = twilio.validateRequest(
    route.authToken,
    signature,
    fullUrl,
    params,
  );
  if (!valid) {
    console.warn(
      `[twilio/voice] invalid signature (sa=${route.subAccountId})`,
    );
    return new NextResponse("Invalid signature", { status: 403 });
  }

  // "already_forwarded" mode: the client kept their own existing business
  // number and their carrier only forwards HERE when a call goes unanswered.
  // By the time Twilio receives it, it has already missed — there's nothing
  // left to dial, so skip <Dial> entirely and go straight to the text-back.
  if (route.missedCall.mode === "already_forwarded") {
    const callSid = (params["CallSid"] as string | undefined) ?? "";
    try {
      const result = await handleMissedCall({ route, from, callSid });
      if (!result.handled) {
        console.warn(
          `[twilio/voice] not handled (sa=${route.subAccountId}, reason=${result.reason})`,
        );
      }
    } catch (err) {
      console.error(
        `[twilio/voice] handler failed (sa=${route.subAccountId})`,
        err,
      );
    }
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<Response>" +
      "<Say>Thanks for calling. We'll text you back in just a moment.</Say>" +
      "<Hangup/>" +
      "</Response>";
    return xml(twiml);
  }

  const timeout = Math.min(
    60,
    Math.max(5, route.missedCall.ringTimeoutSec || DEFAULT_MCTB_RING_TIMEOUT_SEC),
  );
  const action = statusCallbackUrl();
  // callerId passthrough: the business sees the lead's real number. `from` is
  // the inbound caller (a number that just dialled our Twilio number).
  const callerId = escapeXml(normalisePhone(from));
  const forwardTo = escapeXml(route.missedCall.forwardTo);

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    `<Dial timeout="${timeout}" callerId="${callerId}" action="${escapeXml(action)}" method="POST">` +
    `<Number>${forwardTo}</Number>` +
    "</Dial>" +
    "</Response>";

  return xml(twiml);
}
