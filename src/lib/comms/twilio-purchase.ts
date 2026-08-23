import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { buildTwilioClient } from "@/lib/comms/twilio";
import { autoConfigureInboundWebhook } from "@/lib/comms/twilio-config";
import { slugifyE164 } from "@/lib/comms/sms-pool";
import { STATE_AREA_CODES } from "@/lib/comms/us-area-codes";
import type { TwilioPoolNumber } from "@/types";

/**
 * Buys ONE new Twilio number for a sub-account's cold-SMS pool, SMS-only
 * (no voice/SIP-trunk attachment — this pool exists purely to spread
 * outbound texting load, unlike the operator's prior tooling which also
 * wired numbers into a voice-agent trunk for an unrelated product). Tries
 * each area code for the requested state in order until one has
 * availability; falls back to a generic nationwide search if the state
 * isn't in `STATE_AREA_CODES` or every area code for it is exhausted.
 *
 * Every call site MUST have already gotten explicit operator confirmation
 * of quantity before calling this in a loop — this function itself does
 * not gate on cost, it just executes one purchase.
 */
export async function buyNumberForState(
  subAccountId: string,
  accountSid: string,
  authToken: string,
  state: string | null,
): Promise<{ number: TwilioPoolNumber | null; error: string | null }> {
  const client = buildTwilioClient(accountSid, authToken);
  const areaCodes = (state && STATE_AREA_CODES[state]) || [];

  let picked: string | null = null;
  let lastError = "No area codes available to search.";

  for (const ac of [...areaCodes, null]) {
    try {
      const results = await client
        .availablePhoneNumbers("US")
        .local.list(
          ac
            ? { areaCode: Number(ac), smsEnabled: true, limit: 1 }
            : { smsEnabled: true, limit: 1 },
        );
      if (results.length > 0) {
        picked = results[0].phoneNumber;
        break;
      }
      lastError = ac
        ? `No numbers available for area code ${ac}.`
        : "No numbers available nationwide.";
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Search failed.";
    }
    if (!ac) break; // that was the nationwide fallback attempt — stop either way
  }

  if (!picked) {
    return { number: null, error: lastError };
  }

  try {
    await client.incomingPhoneNumbers.create({ phoneNumber: picked });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Purchase failed.";
    return { number: null, error: `Number search succeeded but purchase failed: ${message}` };
  }

  const db = getAdminDb();
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
  const webhookUrl = base ? `${base}/api/webhooks/twilio/inbound` : "";
  let webhookOk = false;
  let dateCreated: Date | null = null;
  if (webhookUrl) {
    const result = await autoConfigureInboundWebhook({
      accountSid,
      authToken,
      fromNumber: picked,
      webhookUrl,
    });
    webhookOk = result.ok;
    dateCreated = result.dateCreated ?? null;
  }

  const numberId = slugifyE164(picked);
  const doc: TwilioPoolNumber = {
    id: numberId,
    e164: picked,
    label: picked,
    enabled: true,
    isPrimary: false,
    ratePerMinuteOverride: null,
    nextAvailableAt: null,
    cursorUpdatedAt: null,
    inboundWebhookConfigured: webhookOk,
    lifetimeSent: 0,
    lifetimeErrors: 0,
    lastErrorAt: null,
    autoDisabledAt: null,
    retellAgentId: null,
    purchasedAt: dateCreated
      ? (dateCreated as unknown as TwilioPoolNumber["purchasedAt"])
      : (FieldValue.serverTimestamp() as unknown as TwilioPoolNumber["purchasedAt"]),
    archivedAt: null,
    createdAt: FieldValue.serverTimestamp() as unknown as TwilioPoolNumber["createdAt"],
    updatedAt: FieldValue.serverTimestamp() as unknown as TwilioPoolNumber["updatedAt"],
  };
  await db.doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`).set(doc);

  return { number: doc, error: null };
}
