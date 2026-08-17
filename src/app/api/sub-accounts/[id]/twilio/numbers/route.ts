import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { autoConfigureInboundWebhook } from "@/lib/comms/twilio-config";
import { slugifyE164 } from "@/lib/comms/sms-pool";
import type { TwilioConfig, TwilioPoolNumber } from "@/types";

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
  const cfg = (subSnap.data()?.twilioConfig as TwilioConfig | undefined) ?? null;
  const numbers = numbersSnap.docs
    .map((d) => d.data() as TwilioPoolNumber)
    .sort((a, b) => a.label.localeCompare(b.label));

  return NextResponse.json({
    numberPoolEnabled: cfg?.numberPoolEnabled === true,
    defaultRatePerMinutePerNumber: cfg?.defaultRatePerMinutePerNumber ?? 2,
    numbers,
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
  let webhookResult = { ok: false, error: null as string | null };
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
