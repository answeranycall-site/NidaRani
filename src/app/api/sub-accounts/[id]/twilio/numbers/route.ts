import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import {
  autoConfigureInboundWebhook,
  type AutoConfigureWebhookResult,
} from "@/lib/comms/twilio-config";
import { slugifyE164 } from "@/lib/comms/sms-pool";
import { buildTwilioClient } from "@/lib/comms/twilio";
import type { SubAccountDoc, TwilioConfig, TwilioPoolNumber } from "@/types";

/** A number's Voice URL is "fine" (not flagged) if it's blank, points at
 *  our own webhook, or points at Missed Call Text Back's handler — only a
 *  foreign/stale URL gets flagged. A Retell-bound number is checked
 *  separately (against the configured SIP termination, not this URL). */
function voiceUrlLooksOk(voiceUrl: string, ourBase: string): boolean {
  if (!voiceUrl) return true;
  if (ourBase && voiceUrl.startsWith(ourBase)) return true;
  return false;
}

/**
 * Manage a sub-account's outbound-sending number pool (10-12 numbers for a
 * cold-outreach campaign, all sharing the sub-account's existing dedicated
 * Twilio account/token — see `types/tenancy.ts::TwilioPoolNumber`). The
 * legacy single `twilioConfig.fromNumber` config must already be set up
 * (Settings → SMS) before numbers can be added here — the pool reuses that
 * same `accountSid`/`authToken`, it doesn't collect its own.
 *
 * GET   — list the pool + the sub-account's pool-level settings.
 * POST  — add one number (validates it belongs to the account, best-effort
 *         configures its inbound webhook, first number added becomes primary
 *         and flips `numberPoolEnabled` on).
 * PATCH — update pool-level settings (`defaultRatePerMinutePerNumber`,
 *         `numberPoolEnabled`).
 */

function inboundWebhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/inbound`;
}

function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const [subSnap, numbersSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db.collection(`subAccounts/${subAccountId}/twilioNumbers`).get(),
  ]);
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;
  const cfg = (subSnap.data()?.twilioConfig as TwilioConfig | undefined) ?? null;
  const numbers = numbersSnap.docs
    .map((d) => d.data() as TwilioPoolNumber)
    .sort((a, b) => a.label.localeCompare(b.label));

  // Last-24h stats aren't stored on the number doc (see TwilioPoolNumber's
  // doc comment) — computed here via count() aggregation queries against
  // each number's statusEvents subcollection so there's no rolling-window
  // field to keep in sync elsewhere.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last24h = await Promise.all(
    numbers.map(async (n) => {
      const base = db.collection(
        `subAccounts/${subAccountId}/twilioNumbers/${n.id}/statusEvents`,
      );
      const [sentSnap, errSnap] = await Promise.all([
        base.where("createdAt", ">=", cutoff).count().get(),
        base
          .where("createdAt", ">=", cutoff)
          .where("errorCode", "==", "30007")
          .count()
          .get(),
      ]);
      return {
        id: n.id,
        last24hSent: sentSnap.data().count,
        last24hErrors: errSnap.data().count,
      };
    }),
  );
  const last24hById = new Map(last24h.map((s) => [s.id, s]));

  // Live hook-status — ONE bulk Twilio list call (not N per-number lookups)
  // so this stays cheap even at ~50 numbers. Compared against what SHOULD
  // be configured; drift (someone changed it in the Twilio console, or a
  // number was imported before this app existed) gets flagged with a Fix
  // action rather than silently trusted from the stamped-at-add-time flag.
  const hookStatusByE164 = new Map<
    string,
    { smsUrl: string; voiceUrl: string }
  >();
  let hookCheckError: string | null = null;
  if (cfg?.accountSid && cfg.authToken && numbers.length > 0) {
    try {
      const client = buildTwilioClient(cfg.accountSid, cfg.authToken);
      const list = await client.incomingPhoneNumbers.list({ limit: 1000 });
      for (const n of list) {
        hookStatusByE164.set(n.phoneNumber, {
          smsUrl: n.smsUrl || "",
          voiceUrl: n.voiceUrl || "",
        });
      }
    } catch (err) {
      hookCheckError = err instanceof Error ? err.message : "Twilio lookup failed.";
    }
  }
  const ourSmsWebhook = inboundWebhookUrl();
  const ourBase = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";

  return NextResponse.json({
    numberPoolEnabled: cfg?.numberPoolEnabled === true,
    defaultRatePerMinutePerNumber: cfg?.defaultRatePerMinutePerNumber ?? 2,
    hookCheckError,
    numbers: numbers.map((n) => {
      const live = hookStatusByE164.get(n.e164);
      return {
        ...n,
        last24hSent: last24hById.get(n.id)?.last24hSent ?? 0,
        last24hErrors: last24hById.get(n.id)?.last24hErrors ?? 0,
        smsHookOk: live ? live.smsUrl === ourSmsWebhook : null,
        voiceHookOk: live ? voiceUrlLooksOk(live.voiceUrl, ourBase) : null,
        currentVoiceUrl: live?.voiceUrl || null,
      };
    }),
  });
}

interface PostBody {
  e164?: string;
  label?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const e164Raw = body.e164?.trim() ?? "";
  const e164 = e164Raw ? normalisePhone(e164Raw) : "";
  const label = body.label?.trim() || e164;
  if (!e164.startsWith("+")) {
    return NextResponse.json(
      { error: "Number must be E.164 (e.g. +15551234567)." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;
  const cfg = (subSnap.data()?.twilioConfig as TwilioConfig | undefined) ?? null;
  if (!cfg?.enabled || !cfg.accountSid || !cfg.authToken) {
    return NextResponse.json(
      {
        error:
          "Set up your primary dedicated Twilio number first (Settings → SMS) — the pool reuses that account's credentials.",
      },
      { status: 400 },
    );
  }

  const numberId = slugifyE164(e164);
  const numberRef = db.doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`);
  if ((await numberRef.get()).exists) {
    return NextResponse.json(
      { error: "This number is already in the pool." },
      { status: 409 },
    );
  }

  const webhookUrl = inboundWebhookUrl();
  let webhookResult: AutoConfigureWebhookResult = { ok: false, error: null };
  if (webhookUrl) {
    webhookResult = await autoConfigureInboundWebhook({
      accountSid: cfg.accountSid,
      authToken: cfg.authToken,
      fromNumber: e164,
      webhookUrl,
    });
  } else {
    webhookResult.error = "NEXT_PUBLIC_APP_URL is not set on this deployment.";
  }

  const existingCountSnap = await db
    .collection(`subAccounts/${subAccountId}/twilioNumbers`)
    .count()
    .get();
  const isFirst = existingCountSnap.data().count === 0;

  const doc: TwilioPoolNumber = {
    id: numberId,
    e164,
    label,
    enabled: true,
    isPrimary: isFirst,
    ratePerMinuteOverride: null,
    nextAvailableAt: null,
    cursorUpdatedAt: null,
    inboundWebhookConfigured: webhookResult.ok,
    lifetimeSent: 0,
    lifetimeErrors: 0,
    lastErrorAt: null,
    autoDisabledAt: null,
    retellAgentId: null,
    purchasedAt: webhookResult.dateCreated
      ? (webhookResult.dateCreated as unknown as TwilioPoolNumber["purchasedAt"])
      : null,
    archivedAt: null,
    createdAt: FieldValue.serverTimestamp() as unknown as TwilioPoolNumber["createdAt"],
    updatedAt: FieldValue.serverTimestamp() as unknown as TwilioPoolNumber["updatedAt"],
  };
  await numberRef.set(doc);

  if (isFirst) {
    await subRef.set(
      {
        twilioConfig: {
          numberPoolEnabled: true,
          defaultRatePerMinutePerNumber: cfg.defaultRatePerMinutePerNumber ?? 2,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return NextResponse.json({
    ok: true,
    number: { ...doc, createdAt: null, updatedAt: null },
    inboundWebhookConfigured: webhookResult.ok,
    inboundWebhookError: webhookResult.error,
    inboundWebhookUrl: webhookUrl,
  });
}

interface PatchBody {
  numberPoolEnabled?: boolean;
  defaultRatePerMinutePerNumber?: number;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof body.numberPoolEnabled === "boolean") {
    updates["twilioConfig.numberPoolEnabled"] = body.numberPoolEnabled;
  }
  if (typeof body.defaultRatePerMinutePerNumber === "number") {
    const rate = Math.max(1, Math.min(60, Math.floor(body.defaultRatePerMinutePerNumber)));
    updates["twilioConfig.defaultRatePerMinutePerNumber"] = rate;
  }
  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  await getAdminDb().doc(`subAccounts/${subAccountId}`).update(updates);
  return NextResponse.json({ ok: true });
}
