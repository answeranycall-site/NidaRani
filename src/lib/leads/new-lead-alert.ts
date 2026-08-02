import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import type { SubAccountDoc } from "@/types";

/**
 * "A brand-new lead just came in" alert to the business owner — fired at most
 * ONCE per contact, for the lifetime of that contact, across every inbound
 * channel.
 *
 * Before this module each channel rolled its own notification with its own
 * (or no) dedupe, which is why owners got alerted repeatedly about the same
 * person: SMS keyed off "no matching contact", missed-call keyed off the call
 * SID, web chat keyed off nothing at all, and WhatsApp sent nothing. The gate
 * now lives in one place — `contacts/{id}.ownerAlertedAt` — and every channel
 * routes through here.
 *
 * The claim is transactional and written BEFORE delivery so two webhooks
 * racing on the same cold number can't both send. If delivery then turns out
 * to be impossible (no recipient configured, every transport failed) the claim
 * is released, so the owner isn't permanently robbed of the alert because
 * Resend happened to be down or `accountContact` wasn't filled in yet.
 */

export type NewLeadChannel =
  | "sms"
  | "whatsapp"
  | "web-chat"
  | "voice"
  | "messenger"
  | "instagram";

const CHANNEL_LABEL: Record<NewLeadChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  "web-chat": "Web Chat",
  voice: "phone call",
  messenger: "Facebook Messenger",
  instagram: "Instagram DM",
};

export interface NewLeadAlertInput {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  channel: NewLeadChannel;
  /** Pass the already-loaded sub-account to save a read; loaded if omitted. */
  subAccount?: SubAccountDoc | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  /** What they actually said / asked, quoted in the alert when present. */
  preview?: string | null;
}

export interface NewLeadAlertResult {
  alerted: boolean;
  reason?:
    | "already_alerted"
    | "no_recipient"
    | "delivery_failed"
    | "claim_failed";
  viaEmail?: boolean;
  viaSms?: boolean;
}

/**
 * Transactionally claim the one-time alert slot. Returns false when another
 * writer already holds it (or already alerted at some point in the past).
 *
 * Exported so channels that build their own richer alert (Web Chat + Voice
 * capture, which send a lead-detail email alongside a follow-up Task via
 * lib/comms/ai/follow-up.ts) can share the exact same gate instead of
 * running a parallel one that would let the owner be told twice.
 */
export async function claimOwnerAlertSlot(
  contactId: string,
  channel: NewLeadChannel,
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.collection("contacts").doc(contactId);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      if (snap.get("ownerAlertedAt")) return false;
      tx.set(
        ref,
        {
          ownerAlertedAt: FieldValue.serverTimestamp(),
          ownerAlertedChannel: channel,
        },
        { merge: true },
      );
      return true;
    });
  } catch (err) {
    // Fail CLOSED: a transaction error means we can't prove we're the only
    // sender, and a duplicate owner alert is exactly the complaint this
    // module exists to fix. Missing one alert beats sending five.
    console.warn("[new-lead-alert] claim transaction failed", err);
    return false;
  }
}

/** Undo a claim when delivery turned out to be impossible, so the owner
 *  isn't permanently robbed of the alert by a transient outage. */
export async function releaseOwnerAlertSlot(contactId: string): Promise<void> {
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .set(
        {
          ownerAlertedAt: FieldValue.delete(),
          ownerAlertedChannel: FieldValue.delete(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[new-lead-alert] claim release failed", err);
  }
}

function buildEmail(
  input: NewLeadAlertInput,
  subAccount: SubAccountDoc | null,
  appUrl: string,
): { subject: string; text: string; html: string } {
  const via = CHANNEL_LABEL[input.channel];
  const who =
    (input.contactName ?? "").trim() ||
    (input.contactPhone ?? "").trim() ||
    (input.contactEmail ?? "").trim() ||
    "Someone new";
  const link = `${appUrl}/sa/${input.subAccountId}/conversations/${input.contactId}`;
  const business = subAccount?.name?.trim() || "your business";
  const preview = (input.preview ?? "").trim();

  const detailLines = [
    `Name:     ${(input.contactName ?? "").trim() || "(not given yet)"}`,
    input.contactPhone ? `Phone:    ${input.contactPhone}` : null,
    input.contactEmail ? `Email:    ${input.contactEmail}` : null,
    `Channel:  ${via}`,
  ].filter(Boolean);

  const text = [
    `${who} just reached ${business} for the first time via ${via}.`,
    "",
    ...detailLines,
    ...(preview ? ["", "They said:", `"${preview}"`] : []),
    "",
    "Open the conversation:",
    link,
    "",
    "(You'll only get this once per new lead — replies won't re-notify you.)",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#1a1a22;line-height:1.6;">
  <div style="font-size:11px;text-transform:uppercase;color:#5b5bd6;letter-spacing:0.08em;font-weight:600;">New lead</div>
  <h1 style="font-size:18px;font-weight:600;margin:6px 0 16px;">${escapeHtml(who)} just reached you via ${escapeHtml(via)}</h1>
  <div style="background:#f6f7f9;border-radius:8px;padding:14px 16px;margin:16px 0;font-size:14px;">
    <p style="margin:0 0 4px;"><strong>${escapeHtml((input.contactName ?? "").trim() || "(name not given yet)")}</strong></p>
    ${input.contactPhone ? `<p style="margin:0 0 2px;color:#3a3a44;">${escapeHtml(input.contactPhone)}</p>` : ""}
    ${input.contactEmail ? `<p style="margin:0 0 2px;color:#3a3a44;">${escapeHtml(input.contactEmail)}</p>` : ""}
    ${preview ? `<p style="margin:8px 0 0;color:#3a3a44;font-style:italic;">&ldquo;${escapeHtml(preview)}&rdquo;</p>` : ""}
  </div>
  <p style="margin:24px 0;">
    <a href="${escapeHtml(link)}" style="display:inline-block;background:#5b5bd6;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">Open the conversation &rarr;</a>
  </p>
  <p style="margin:0;color:#8a8a96;font-size:12px;">You'll only get this once per new lead — their replies won't re-notify you.</p>
</body></html>`;

  return {
    subject: `New ${via} lead: ${who}`,
    text,
    html,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Alert the owner about a brand-new lead, at most once per contact ever.
 * Best-effort and non-throwing — callers can `void` this without a catch.
 */
export async function alertOwnerOfNewLeadOnce(
  input: NewLeadAlertInput,
): Promise<NewLeadAlertResult> {
  const claimed = await claimOwnerAlertSlot(input.contactId, input.channel);
  if (!claimed) return { alerted: false, reason: "already_alerted" };

  let subAccount = input.subAccount ?? null;
  if (!subAccount) {
    try {
      const snap = await getAdminDb()
        .doc(`subAccounts/${input.subAccountId}`)
        .get();
      subAccount = snap.exists ? (snap.data() as SubAccountDoc) : null;
    } catch (err) {
      console.warn("[new-lead-alert] sub-account load failed", err);
    }
  }

  const ownerEmail = subAccount?.accountContact?.email?.trim() || null;
  const ownerPhone = subAccount?.accountContact?.phone?.trim() || null;

  if (!ownerEmail && !ownerPhone) {
    // Nothing configured to alert. Release so the owner still gets told
    // about their next new lead once they fill in Settings → Account contact.
    await releaseOwnerAlertSlot(input.contactId);
    return { alerted: false, reason: "no_recipient" };
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
  let viaEmail = false;
  let viaSms = false;

  if (ownerEmail && emailIsConfigured()) {
    try {
      const { subject, text, html } = buildEmail(input, subAccount, appUrl);
      await sendEmail({
        to: ownerEmail,
        subject,
        text,
        html,
        from: tenantFrom(subAccount ?? undefined),
      });
      viaEmail = true;
    } catch (err) {
      console.warn("[new-lead-alert] owner email failed", err);
    }
  }

  if (ownerPhone && subAccount) {
    try {
      const who =
        (input.contactName ?? "").trim() ||
        (input.contactPhone ?? "").trim() ||
        "someone new";
      await sendSmsForSubAccount({
        subAccountId: input.subAccountId,
        subAccount,
        to: ownerPhone,
        body: `New ${CHANNEL_LABEL[input.channel]} lead: ${who}${
          input.contactPhone ? ` (${input.contactPhone})` : ""
        }. Open it in your inbox to reply.`,
      });
      viaSms = true;
    } catch (err) {
      console.warn("[new-lead-alert] owner SMS failed", err);
    }
  }

  if (!viaEmail && !viaSms) {
    // Every transport failed — don't burn the one-shot on a transient outage.
    await releaseOwnerAlertSlot(input.contactId);
    return { alerted: false, reason: "delivery_failed" };
  }

  return { alerted: true, viaEmail, viaSms };
}
