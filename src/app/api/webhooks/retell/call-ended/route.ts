import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import {
  asBool,
  asString,
  durationSecFromCall,
  verifyRetellSignature,
  type RetellCall,
  type RetellWebhookBody,
} from "@/lib/comms/voice/retell-webhook";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Retell AI call-ended webhook for Answer Any Call's OWN business line —
 * NOT a client automation. Separate from /api/webhooks/retell/
 * [subAccountId] (which feeds the fuller Vapi-style voiceCalls pipeline
 * for clients running Retell). This route always targets ONE fixed
 * sub-account (RETELL_OWN_SUBACCOUNT_ID) and follows the simpler shape
 * the Twilio inbound + Meta webhook handlers use: verified webhook →
 * reconcile Contact → log one activity. No Task pipeline beyond an
 * optional "booked a strategy call" follow-up.
 *
 * Signature verification + payload parsing are shared with the other
 * Retell route via lib/comms/voice/retell-webhook.ts — see that file's
 * header comment for the algorithm + field-shape sourcing.
 *
 * Idempotency: Retell retries webhook deliveries, so a claim doc at
 * subAccounts/{id}/retellCallClaims/{callId} makes a repeat delivery a
 * no-op instead of double-logging the activity / double-creating a Task.
 */

interface OwnBusinessCustomAnalysisData {
  name?: string;
  email?: string;
  /** Configure this exact field name under the agent's Post-Call Analysis
   *  settings in the Retell dashboard for the Task creation below to
   *  fire. Any truthy boolean means "yes, they booked one." */
  booked_strategy_call?: boolean;
  /** Free-text — whatever the caller said, e.g. "Tuesday at 2pm". Not
   *  parsed into a real date; just carried into the Task notes. */
  strategy_call_time?: string;
}

async function claimCall(
  subAccountId: string,
  callId: string,
): Promise<boolean> {
  const ref = getAdminDb().doc(
    `subAccounts/${subAccountId}/retellCallClaims/${callId}`,
  );
  try {
    return await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { callId, createdAt: FieldValue.serverTimestamp() });
      return true;
    });
  } catch (err) {
    console.warn("[retell/call-ended] claim transaction failed", err);
    // Fail open — better a rare duplicate than dropping the call entirely
    // on a transient Firestore blip.
    return true;
  }
}

function formatDuration(sec: number): string {
  if (sec <= 0) return "unknown duration";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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

  let body: RetellWebhookBody;
  try {
    body = JSON.parse(rawBody) as RetellWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.event !== "call_analyzed") {
    return NextResponse.json({ ok: true, ignored: body.event ?? "unknown" });
  }

  const call: RetellCall = body.call ?? {};
  const callId = asString(call.call_id);
  if (!callId) {
    return NextResponse.json({ error: "Missing call.call_id" }, { status: 400 });
  }

  const fresh = await claimCall(subAccountId, callId);
  if (!fresh) {
    return NextResponse.json({ ok: true, ignored: "already_handled" });
  }

  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    console.error(
      `[retell/call-ended] RETELL_OWN_SUBACCOUNT_ID=${subAccountId} doesn't exist`,
    );
    return NextResponse.json({ ok: false, error: "sub-account not found" });
  }
  const sa = saSnap.data() as SubAccountDoc;

  const inbound = call.direction !== "outbound";
  const callerPhone = asString(inbound ? call.from_number : call.to_number);
  const durationSec = durationSecFromCall(call);
  const summary = asString(call.call_analysis?.call_summary);
  const recordingUrl = asString(call.recording_url);
  const transcriptText = asString(call.transcript);
  const endedReason = asString(call.disconnection_reason);
  const userSentiment = asString(call.call_analysis?.user_sentiment);
  const custom = (call.call_analysis?.custom_analysis_data ??
    {}) as OwnBusinessCustomAnalysisData;

  let contactId: string | null = null;
  let contactCreated = false;
  if (callerPhone) {
    try {
      const reconciled = await reconcileContactFromCapture({
        agencyId: sa.agencyId,
        subAccountId,
        existingContactId: null,
        pageUrl: null,
        source: "retell-call",
        matchStrategy: "phone-first",
        capture: {
          name: asString(custom.name),
          email: asString(custom.email),
          phone: callerPhone,
        },
      });
      if (reconciled) {
        contactId = reconciled.contactId;
        contactCreated = reconciled.created;
      }
    } catch (err) {
      console.error("[retell/call-ended] contact reconcile failed", err);
    }
  }

  if (!contactId) {
    console.warn(
      `[retell/call-ended] call ${callId} had no caller phone — nothing to log against`,
    );
    return NextResponse.json({ ok: true, skipped: "no_caller_phone" });
  }

  // One rich activity entry — summary + recording link in the visible
  // content; full transcript + sentiment tucked into meta so the timeline
  // stays readable but the detail is still queryable.
  const contentLines = [
    `Retell call (${formatDuration(durationSec)})${endedReason ? ` — ${endedReason}` : ""}`,
    summary ? `Summary: ${summary}` : null,
    recordingUrl ? `Recording: ${recordingUrl}` : null,
  ].filter(Boolean);

  try {
    await db.collection(`contacts/${contactId}/activities`).add({
      type: "retell_call_logged",
      content: contentLines.join("\n"),
      createdBy: "retell_call_webhook",
      meta: {
        callId,
        durationSec,
        recordingUrl,
        transcript: transcriptText,
        endedReason,
        userSentiment,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[retell/call-ended] activity write failed", err);
  }

  // Booked strategy call → a follow-up Task. No pipeline-stage move: this
  // sub-account doesn't model "prospect calls" as deals, and Task is the
  // universal "a human needs to act on this" pattern already used by MCTB,
  // Web Chat capture, and the Vapi/client voice pipeline.
  let taskId: string | null = null;
  if (asBool(custom.booked_strategy_call) === true) {
    try {
      const identity = asString(custom.name) || callerPhone || "this caller";
      const now = new Date();
      const dueAt = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
      );
      const notes = [
        `Booked via Retell call ${callId}.`,
        custom.strategy_call_time
          ? `Requested time: ${custom.strategy_call_time}`
          : null,
        summary ? `Call summary: ${summary}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const result = await createTaskServerSide({
        subAccountId,
        agencyId: sa.agencyId,
        createdByUid: "retell-call-webhook",
        mode: "live",
        title: `Strategy call booked — ${identity}`,
        notes,
        dueAt,
        contactId,
        dealId: null,
        eventId: null,
      });
      taskId = result.id;
    } catch (err) {
      console.error("[retell/call-ended] task creation failed", err);
    }
  }

  return NextResponse.json({ ok: true, contactId, contactCreated, taskId });
}
