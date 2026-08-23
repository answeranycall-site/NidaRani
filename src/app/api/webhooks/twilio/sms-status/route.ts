import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import type { SubAccountDoc, TwilioPoolNumber } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Twilio status-callback webhook, attached to every pooled outbound send
 * (see `lib/comms/sms-pool.ts::deliverPooledSms`'s `statusCallback` param,
 * which encodes `?sa=<subAccountId>&numberId=<numberDocId>`). Tracks
 * lifetime delivery stats per pool number and auto-disables + alerts the
 * operator on a burst of Twilio error 30007 (carrier-filtered as spam) —
 * the same signal the operator's prior tooling flagged numbers on.
 *
 * Public path (security is the Twilio signature, not the session cookie —
 * same model as the inbound SMS webhook). Always returns 200 so Twilio
 * doesn't retry-storm; every failure path is logged, not surfaced.
 */

// Twilio calls back through queued -> sending -> {sent -> delivered|
// undelivered} or -> failed. We only want to count each message ONCE
// regardless of how many callbacks it generates, so any of these "the
// message has left our hands" statuses is eligible to trigger the count —
// the statusEvents/{sid} idempotency doc (created on the FIRST eligible
// callback) is what actually prevents double-counting a sent->delivered
// pair, not this list.
const SETTLED_STATUSES = new Set(["sent", "delivered", "undelivered", "failed"]);

// 3+ 30007s within 15 minutes on one number auto-disables it — matches the
// operator's prior tooling's rough threshold. Not yet operator-configurable.
const ERROR_BURST_THRESHOLD = 3;
const ERROR_BURST_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const subAccountId = url.searchParams.get("sa");
  const numberId = url.searchParams.get("numberId");
  if (!subAccountId || !numberId) {
    return NextResponse.json({ error: "Missing sa/numberId" }, { status: 400 });
  }

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const subAccount = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  const authToken = subAccount?.twilioConfig?.authToken;
  if (!authToken) {
    console.warn(`[sms-status] no authToken for sa=${subAccountId} — dropping`);
    return NextResponse.json({ ok: true });
  }

  const signature = request.headers.get("x-twilio-signature");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}${url.search}`;
  const valid =
    !!signature && twilio.validateRequest(authToken, signature, fullUrl, params);
  if (!valid) {
    console.warn(`[sms-status] invalid signature sa=${subAccountId} numberId=${numberId}`);
    return NextResponse.json({ ok: true });
  }

  const status = String(params.MessageStatus || "").toLowerCase();
  const messageSid = String(params.MessageSid || "");
  const errorCode = params.ErrorCode ? String(params.ErrorCode) : null;
  if (!messageSid || !SETTLED_STATUSES.has(status)) {
    return NextResponse.json({ ok: true });
  }

  const numberRef = db.doc(
    `subAccounts/${subAccountId}/twilioNumbers/${numberId}`,
  );
  const eventRef = numberRef.collection("statusEvents").doc(messageSid);
  const is30007 = errorCode === "30007";

  let firstTimeSettled = false;
  try {
    firstTimeSettled = await db.runTransaction(async (tx) => {
      const eventSnap = await tx.get(eventRef);
      if (eventSnap.exists) return false; // already counted this message
      tx.set(eventRef, {
        messageSid,
        status,
        errorCode,
        createdAt: FieldValue.serverTimestamp(),
      });
      const patch: Record<string, unknown> = {
        lifetimeSent: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (is30007) {
        patch.lifetimeErrors = FieldValue.increment(1);
        patch.lastErrorAt = FieldValue.serverTimestamp();
      }
      tx.set(numberRef, patch, { merge: true });
      return true;
    });
  } catch (err) {
    console.warn(`[sms-status] transaction failed sa=${subAccountId} numberId=${numberId}`, err);
    return NextResponse.json({ ok: true });
  }

  if (!firstTimeSettled || !is30007) {
    return NextResponse.json({ ok: true });
  }

  // Burst check — only worth doing on the (comparatively rare) 30007 path.
  try {
    const windowStart = new Date(Date.now() - ERROR_BURST_WINDOW_MS);
    const burstSnap = await numberRef
      .collection("statusEvents")
      .where("errorCode", "==", "30007")
      .where("createdAt", ">=", windowStart)
      .count()
      .get();
    const burstCount = burstSnap.data().count;
    if (burstCount < ERROR_BURST_THRESHOLD) return NextResponse.json({ ok: true });

    const numberSnap = await numberRef.get();
    const number = numberSnap.data() as TwilioPoolNumber | undefined;
    if (!number || !number.enabled || number.autoDisabledAt) {
      // Already off, or the doc vanished — nothing to do.
      return NextResponse.json({ ok: true });
    }

    await numberRef.set(
      {
        enabled: false,
        autoDisabledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const alertPhone = subAccount?.accountContact?.phone?.trim();
    if (alertPhone && subAccount) {
      try {
        await sendSmsForSubAccount({
          subAccountId,
          subAccount,
          to: alertPhone,
          body: `Cold SMS: ${number.label || number.e164} hit ${burstCount} carrier-spam errors in 15 min and has been auto-disabled. Re-enable it on the Cold SMS page once you've confirmed it's clean.`,
        });
      } catch (err) {
        console.warn(`[sms-status] owner alert failed sa=${subAccountId}`, err);
      }
    }
  } catch (err) {
    console.warn(`[sms-status] burst-check failed sa=${subAccountId} numberId=${numberId}`, err);
  }

  return NextResponse.json({ ok: true });
}
