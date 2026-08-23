import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { buildTwilioClient } from "@/lib/comms/twilio";
import { autoConfigureInboundWebhook } from "@/lib/comms/twilio-config";
import { slugifyE164 } from "@/lib/comms/sms-pool";
import type { SubAccountDoc, TwilioConfig, TwilioPoolNumber } from "@/types";

/**
 * Pull every number the sub-account's Twilio account actually owns and
 * adopt any that aren't already tracked in the pool — the operator has
 * ~50 pre-existing numbers from before this feature existed; this is the
 * bulk alternative to adding them one at a time via `POST ../numbers`.
 *
 * Never overwrites an already-tracked number's `enabled`/`label`/rate
 * override/isPrimary — a re-sync is safe to run repeatedly (e.g. after
 * buying more numbers) without disturbing operator-set state.
 */

function inboundWebhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/inbound`;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

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

  let twilioNumbers: {
    phoneNumber: string;
    friendlyName: string | null;
    dateCreated: Date | null;
  }[];
  try {
    const client = buildTwilioClient(cfg.accountSid, cfg.authToken);
    const list = await client.incomingPhoneNumbers.list({ limit: 1000 });
    twilioNumbers = list.map((n) => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName || null,
      dateCreated: n.dateCreated ?? null,
    }));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Twilio rejected the list request.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const existingSnap = await db
    .collection(`subAccounts/${subAccountId}/twilioNumbers`)
    .get();
  const existingIds = new Set(existingSnap.docs.map((d) => d.id));
  const hadAnyBefore = existingSnap.size > 0;

  const webhookUrl = inboundWebhookUrl();
  let added = 0;
  let webhookFailures = 0;
  let isFirstAdded = !hadAnyBefore;

  for (const n of twilioNumbers) {
    const numberId = slugifyE164(n.phoneNumber);
    if (existingIds.has(numberId)) continue;

    let webhookOk = false;
    if (webhookUrl) {
      const result = await autoConfigureInboundWebhook({
        accountSid: cfg.accountSid,
        authToken: cfg.authToken,
        fromNumber: n.phoneNumber,
        webhookUrl,
      });
      webhookOk = result.ok;
      if (!result.ok) webhookFailures++;
    }

    const doc: TwilioPoolNumber = {
      id: numberId,
      e164: n.phoneNumber,
      label: n.friendlyName || n.phoneNumber,
      enabled: true,
      isPrimary: isFirstAdded,
      ratePerMinuteOverride: null,
      nextAvailableAt: null,
      cursorUpdatedAt: null,
      inboundWebhookConfigured: webhookOk,
      lifetimeSent: 0,
      lifetimeErrors: 0,
      lastErrorAt: null,
      autoDisabledAt: null,
      retellAgentId: null,
      purchasedAt: n.dateCreated
        ? (n.dateCreated as unknown as TwilioPoolNumber["purchasedAt"])
        : null,
      archivedAt: null,
      createdAt: FieldValue.serverTimestamp() as unknown as TwilioPoolNumber["createdAt"],
      updatedAt: FieldValue.serverTimestamp() as unknown as TwilioPoolNumber["updatedAt"],
    };
    await db
      .doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`)
      .set(doc);
    existingIds.add(numberId);
    added++;
    isFirstAdded = false;
  }

  if (added > 0 && !hadAnyBefore) {
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
    foundInTwilio: twilioNumbers.length,
    alreadyTracked: twilioNumbers.length - added,
    added,
    webhookFailures,
  });
}
