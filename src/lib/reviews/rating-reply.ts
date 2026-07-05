import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { buildReviewClickUrl } from "@/lib/reviews/click-token";
import {
  DEFAULT_INTERNAL_FEEDBACK_MESSAGE,
  DEFAULT_REVIEW_SMS_TEMPLATE,
  MAX_RATING_REPLY_ATTEMPTS,
  RATING_REPLY_WINDOW_MS,
} from "@/lib/reviews/constants";
import { firstWord, fillReviewSms } from "@/lib/reviews/request";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Pull a 1-5 rating out of a reply that isn't JUST a bare digit — "5, great
 * job!", "I'd say 5 stars", "5/5" all have a standalone 1-5 token somewhere
 * in a short reply. `\b` word boundaries stop a phone number ("555-1234") or
 * a time ("5pm") from matching, since neither has a boundary around a lone
 * digit. Scoped to short replies (≤12 words) so an unrelated long message
 * that happens to contain a stray 1-5 digit doesn't get misread.
 */
function extractExplicitRating(body: string): number | null {
  const trimmed = body.trim();
  const word = firstWord(trimmed);
  if (/^[1-5]$/.test(word)) return Number(word);

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 12) return null;
  const match = trimmed.match(/\b([1-5])\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Fallback for a reply with no digit at all — "It was amazing!" / "not
 * great honestly" — asks the already-configured LLM to translate sentiment
 * into an equivalent 1-5 rating. Only runs when nothing digit-based
 * matched, so the common case (customer just replies "5") never spends a
 * token. Returns null on any ambiguity, API failure, or missing key —
 * callers treat that exactly like "couldn't tell", never throwing.
 */
async function inferRatingFromSentiment(body: string): Promise<number | null> {
  if (!aiIsConfigured()) return null;
  const trimmed = body.trim();
  // A reply this long is unlikely to be answering the rating question at
  // all (more likely an unrelated message) — skip the AI call rather than
  // risk misclassifying a topic change as a rating.
  if (!trimmed || trimmed.length > 300) return null;

  try {
    const result = await callAi({
      maxTokens: 5,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "A customer was just asked to rate a business's service from 1 to 5 stars. " +
            "Translate their reply into that 1-5 scale based on sentiment. " +
            'Respond with ONLY a single digit 1-5, or the word NONE if the reply ' +
            "doesn't express any opinion about the service (e.g. it's off-topic " +
            "or asks a question instead).",
        },
        { role: "user", content: trimmed },
      ],
    });
    const out = result.text.trim();
    return /^[1-5]$/.test(out) ? Number(out) : null;
  } catch (err) {
    console.warn("[reviews/rating-reply] sentiment inference failed", err);
    return null;
  }
}

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

  // Tier 1: a literal digit somewhere in a short reply ("5", "5, thanks!",
  // "I'd say 5 stars"). Tier 2: no digit at all ("It was amazing!") — ask
  // the LLM to translate sentiment into the same 1-5 scale. Tier 2 only
  // runs when tier 1 comes up empty, so the common bare-digit reply never
  // costs a token.
  const rating =
    extractExplicitRating(input.body) ?? (await inferRatingFromSentiment(input.body));

  if (rating !== null) {
    // Resolved — close the gate and reset the ambiguous-attempt counter.
    await db.doc(`contacts/${input.contact.id}`).set(
      {
        awaitingReviewReplyAt: FieldValue.delete(),
        awaitingReviewReplyAttempts: FieldValue.delete(),
        lastReviewRating: rating,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } else {
    // Ambiguous — a typo'd or off-topic reply shouldn't close the gate on
    // the very first miss, since the real answer might be 1-2 texts away.
    // Give it a few tries before assuming they were never going to answer.
    const attempts = (input.contact.awaitingReviewReplyAttempts ?? 0) + 1;
    if (attempts >= MAX_RATING_REPLY_ATTEMPTS) {
      await db.doc(`contacts/${input.contact.id}`).set(
        {
          awaitingReviewReplyAt: FieldValue.delete(),
          awaitingReviewReplyAttempts: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      await db.doc(`contacts/${input.contact.id}`).set(
        {
          awaitingReviewReplyAttempts: attempts,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    return { handled: false };
  }

  const businessName = input.subAccount.name ?? "";
  const isPositive = rating >= 4;
  // Never text the raw Google URL — the tracking link (see
  // lib/reviews/click-token.ts) redirects to it after stamping
  // reviewLinkClickedAt.
  const trackedReviewUrl = buildReviewClickUrl(input.contact.id) || cfg.reviewUrl;
  const replyBody = isPositive
    ? fillReviewSms(cfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE, {
        firstName: firstWord(input.contact.name),
        businessName,
        reviewUrl: trackedReviewUrl,
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
