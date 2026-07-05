import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { cleanEnv } from "@/lib/env";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Authenticated proxy for an inbound MMS attachment (image, gif, etc).
 * Twilio's media resource URLs require Basic Auth (Account SID + Auth
 * Token) to fetch, so a browser can never load them directly with a plain
 * <img src>. This route re-reads the stored `mediaUrls[i]` server-side
 * (never trusts a client-supplied URL — only the index is client input),
 * authorizes off the message row's own `subAccountId` (works for
 * "Unknown person" threads too, which have no backing contact doc to join
 * against), picks the right Twilio credentials, and streams the bytes
 * through with the original content-type.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ contactId: string; messageId: string }> },
) {
  const { contactId, messageId } = await ctx.params;

  const db = getAdminDb();
  const msgSnap = await db
    .doc(`contacts/${contactId}/messages/${messageId}`)
    .get();
  if (!msgSnap.exists) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const msg = msgSnap.data() as {
    subAccountId?: string;
    mediaUrls?: string[] | null;
  };
  if (!msg.subAccountId) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  const access = await requireSubAccountMember(request, msg.subAccountId);
  if (access instanceof NextResponse) return access;

  const url = new URL(request.url);
  const index = Number.parseInt(url.searchParams.get("i") ?? "0", 10) || 0;
  const mediaUrl = msg.mediaUrls?.[index];
  if (!mediaUrl || !mediaUrl.startsWith("https://api.twilio.com/")) {
    return NextResponse.json({ error: "No such attachment" }, { status: 404 });
  }

  const saSnap = await db.doc(`subAccounts/${msg.subAccountId}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  const dedicated = sub?.twilioConfig?.enabled && sub.twilioConfig.accountSid;
  const accountSid = dedicated
    ? sub!.twilioConfig!.accountSid
    : cleanEnv(process.env.TWILIO_ACCOUNT_SID);
  const authToken = dedicated
    ? sub!.twilioConfig!.authToken
    : cleanEnv(process.env.TWILIO_AUTH_TOKEN);
  if (!accountSid || !authToken) {
    return NextResponse.json(
      { error: "Twilio isn't configured for this sub-account" },
      { status: 503 },
    );
  }

  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const twilioRes = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!twilioRes.ok || !twilioRes.body) {
    return NextResponse.json(
      { error: "Couldn't fetch attachment from Twilio" },
      { status: 502 },
    );
  }

  return new NextResponse(twilioRes.body, {
    status: 200,
    headers: {
      "Content-Type":
        twilioRes.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
