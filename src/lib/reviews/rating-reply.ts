import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import {
  DEFAULT_INTERNAL_FEEDBACK_MESSAGE,
  DEFAULT_REVIEW_SMS_TEMPLATE,
  RATING_REPLY_WINDOW_MS,
} from "@/lib/reviews/constants";
import { firstWord, fillReviewSms } from "@/lib/reviews/request";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Rating-gate reply interception (SMS, dedicated Twilio only). Called from
 * the inbound webhook right after STOP/START handling and before the
 * generic AI auto-reply fallback — deterministic, not LLM-based, same as
 * the STOP/START keyword check it sits next to.
 *
 * Only acts when `googleReviewConfig.ratingGateEnabled` is on AND the
 * contact has a live `awaitingReviewReplyAt` flag (stamped by
 * maybeSendReviewRequest when it sends the "how many stars" ask). A reply
 * that isn't a recognizable 1-5 clears the flag and falls through to
 * normal handling instead of forcing every future message through this
 * gate.
 */

function toMillis(v: unknown): number | null {
  const maybe = v as { toMillis?: () => number } | null | undefined;
  return maybe && typeof maybe.toMillis === "function" ? maybe.toMillis() : null;
}

export interface RatingReplyInput {
  subAccountId: string;
  agencyId: string;
  contact: Contact;
  subAccount: SubAccountDoc;
  body: string;
}

export interface RatingReplyResult {
  handled: boolean;
  rating?: number;
}

export async function maybeHandleRatingReply(
  input: RatingReplyInput,
): Promise<RatingReplyResult> {
  const cfg = input.subAccount.googleReviewConfig;
  if (!cfg || cfg.ratingGateEnabled !== true) return { handled: false };

  const db = getAdminDb();
  const awaitingMs = toMillis(input.contact.awaitingReviewReplyAt);
  if (!awaitingMs || Date.now() - awaitingMs > RATING_REPLY_WINDOW_MS) {
    return { handled: false };
  }

  const word = input.body.trim().split(/\s+/)[0] ?? "";
  const rating = /^[1-5]$/.test(word) ? Number(word) : null;

  // Clear the gate either way — a non-1-5 reply means they weren't
  // answering the rating question, so don't keep intercepting their
  // future messages waiting for one.
  await db.doc(`contacts/${input.contact.id}`).set(
    {
      awaitingReviewReplyAt: FieldValue.delete(),
      ...(rating !== null ? { lastReviewRating: rating } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (rating === null) return { handled: false };

  const businessName = input.subAccount.name ?? "";
  const isPositive = rating >= 4;
  const replyBody = isPositive
    ? fillReviewSms(cfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE, {
        firstName: firstWord(input.contact.name),
        businessName,
        reviewUrl: cfg.reviewUrl,
      })
    : cfg.internalFeedbackMessage || DEFAULT_INTERNAL_FEEDBACK_MESSAGE;

  let sid: string | null = null;
  let fromNumber = "";
  try {
    const res = await sendSmsForSubAccount({
      subAccountId: input.subAccountId,
      subAccount: input.subAccount,
      to: input.contact.phone,
      body: replyBody,
    });
    sid = res.sid;
    fromNumber = res.from;
  } catch (err) {
    console.warn("[reviews/rating-reply] send failed", err);
  }

  if (sid) {
    try {
      await db
        .collection("contacts")
        .doc(input.contact.id)
        .collection("messages")
        .doc(sid)
        .set({
          agencyId: input.agencyId,
          subAccountId: input.subAccountId,
          contactId: input.contact.id,
          direction: "outbound",
          status: "sent",
          body: replyBody,
          from: fromNumber,
          to: input.contact.phone,
          twilioMessageSid: sid,
          sentByUid: "review-rating-reply",
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[reviews/rating-reply] message-row write failed", err);
    }
    await upsertConversationForMessage({
      contactId: input.contact.id,
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      contactName: input.contact.name ?? "",
      contactPhone: input.contact.phone,
      channel: "sms",
      direction: "outbound",
      body: replyBody,
    });
  }

  try {
    await db
      .collection("contacts")
      .doc(input.contact.id)
      .collection("activities")
      .add({
        type: "review_requested",
        content: `Rated ${rating}/5${isPositive ? " — sent Google review link" : " — internal feedback flow"}.`,
        createdBy: "review-rating-reply",
        meta: { rating, positive: isPositive },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[reviews/rating-reply] activity write failed", err);
  }

  if (!isPositive) {
    await notifyLowRating({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      contact: input.contact,
      rating,
    });
  }

  return { handled: true, rating };
}

/** Task + escalation email for a 1-3 rating reply. Best-effort, never throws. */
async function notifyLowRating(input: {
  subAccountId: string;
  agencyId: string;
  contact: Contact;
  rating: number;
}): Promise<void> {
  const identity = input.contact.name || input.contact.phone || "A customer";
  const db = getAdminDb();

  try {
    const now = new Date();
    const dueAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
    );
    await db.collection("tasks").add({
      title: `Follow up with ${identity} — ${input.rating}/5 review reply`,
      notes: `${identity} replied ${input.rating}/5 to a Google review request. They were sent an apology text automatically — reach out personally to make it right.`,
      dueAt,
      completed: false,
      completedAt: null,
      contactId: input.contact.id,
      dealId: null,
      eventId: null,
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: "review-rating-reply",
      territoryId: input.contact.territoryId ?? null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[reviews/rating-reply] task create failed", err);
  }

  if (!emailIsConfigured()) return;
  try {
    const [agent, subSnap] = await Promise.all([
      resolveAgent(input.subAccountId, "sms"),
      db.doc(`subAccounts/${input.subAccountId}`).get(),
    ]);
    const subAccount = subSnap.data() as SubAccountDoc | undefined;
    const to = agent?.effective.escalationNotifyEmail?.trim();
    if (!to) return;

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
    const contactUrl = `${appUrl}/sa/${input.subAccountId}/contacts/${input.contact.id}`;
    const subject = `${input.rating}/5 review reply from ${identity}`;
    const text = [
      `${identity} replied ${input.rating}/5 to a Google review request.`,
      "",
      "They were automatically sent an apology text — a follow-up Task has",
      "been created due today so someone can reach out personally.",
      "",
      `Contact: ${contactUrl}`,
    ].join("\n");
    const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;padding:28px;">
    <div style="font-size:11px;text-transform:uppercase;color:#dc2626;letter-spacing:0.08em;font-weight:600;">Low review rating</div>
    <h1 style="margin:8px 0 4px;font-size:20px;color:#0f172a;">${escHtml(identity)} rated ${input.rating}/5</h1>
    <p style="margin:0 0 20px;color:#64748b;font-size:14px;">An automatic apology text was sent. A follow-up Task has been created, due today — someone should reach out personally.</p>
    <a href="${escHtml(contactUrl)}" style="display:inline-block;background:#7c3aed;color:white;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;">View contact</a>
  </div>
</body></html>`;

    await sendEmail({ to, subject, text, html, from: tenantFrom(subAccount) });
  } catch (err) {
    console.error("[reviews/rating-reply] email send failed", err);
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
