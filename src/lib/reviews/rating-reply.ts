import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { publishCallback } from "@/lib/automations/qstash";
import { buildReviewClickUrl } from "@/lib/reviews/click-token";
import {
  DEFAULT_INTERNAL_FEEDBACK_MESSAGE,
  DEFAULT_REVIEW_SMS_TEMPLATE,
  MAX_RATING_REPLY_ATTEMPTS,
  RATING_HOLD_WINDOW_SEC,
  RATING_REPLY_WINDOW_MS,
} from "@/lib/reviews/constants";
import { firstWord, fillReviewSms } from "@/lib/reviews/request";
import { resumeReviewRatingRun } from "@/lib/workflows/engine";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Rating-gate reply interception (SMS, dedicated Twilio only). Called from
 * the inbound webhook right after STOP/START handling and before the
 * generic AI auto-reply fallback.
 *
 * Only acts when `googleReviewConfig.ratingGateEnabled` is on AND the
 * contact has a live `awaitingReviewReplyAt` flag (stamped by
 * maybeSendReviewRequest when it sends the "how many stars" ask).
 *
 * Three sub-states within that window, in priority order:
 *   1. `pendingRatingConfirm` set — waiting on an explicit yes/no (or a
 *      fresh digit) to an AI-proposed rating. See `handleConfirmReply`.
 *   2. `pendingRatingHoldValue` set — a clean single-digit reply is being
 *      held for RATING_HOLD_WINDOW_SEC in case a same-minute correction
 *      arrives. See `handleDuringHold`.
 *   3. Neither — a fresh reply. See `classifyFreshReply`.
 *
 * AI only ever gets involved for the genuinely ambiguous cases (2+ numbers
 * in one reply, a reply that conflicts with a held digit, or free text with
 * no digit at all) — a clean, unambiguous single-digit reply is read and
 * held deterministically, no LLM call. Every AI-derived rating is confirmed
 * with the customer before being treated as final; a held deterministic
 * reply is not (it's unambiguous by construction), but still gets a
 * RATING_HOLD_WINDOW_SEC grace period before committing, in case a
 * corrective follow-up text lands moments later.
 */

/** Every DISTINCT 1-5 digit appearing in the reply, in order of first
 *  appearance — "3 or 5" -> [3, 5]; "5, great job!" -> [5]; "555-1234" ->
 *  [] (word-boundary guarded). Same ≤12-word scope as extractExplicitRating. */
function extractAllExplicitRatings(body: string): number[] {
  const trimmed = body.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 12) return [];
  const seen = new Set<number>();
  for (const m of trimmed.matchAll(/\b([1-5])\b/g)) {
    seen.add(Number(m[1]));
  }
  return [...seen];
}

function isAffirmative(body: string): boolean {
  const t = body.trim().toLowerCase().replace(/[.!]+$/, "");
  return /^(y|ya|yea|yeah|yep|yup|yes|correct|right|that'?s right|thats right|confirmed|👍|✅)$/.test(
    t,
  );
}

function isNegative(body: string): boolean {
  const t = body.trim().toLowerCase().replace(/[.!]+$/, "");
  return /^(n|no|nope|nah|wrong|incorrect|that'?s not right|thats not right)$/.test(
    t,
  );
}

/**
 * Resolves an ambiguous reply into a single 1-5 (or null if genuinely
 * unreadable) via the already-configured LLM. Used for: free text with no
 * digit, a message naming 2+ distinct digits, or a new reply that
 * conflicts with an already-held digit from a moments-ago message. When
 * `priorMessage` is set, the model is told the customer may be
 * correcting/clarifying their first answer.
 */
async function disambiguateRating(
  latestMessage: string,
  priorMessage?: string,
): Promise<number | null> {
  if (!aiIsConfigured()) return null;
  const trimmed = latestMessage.trim();
  if (!trimmed || trimmed.length > 300) return null;

  const systemPrompt = priorMessage
    ? "A customer was asked to rate a business's service from 1 to 5 stars. " +
      "They sent two messages close together — they may be correcting or " +
      "clarifying their first answer. Decide their FINAL intended rating, " +
      "favoring the more recent message when the two conflict. Respond " +
      "with ONLY a single digit 1-5, or the word NONE if neither message " +
      "expresses a clear rating."
    : "A customer was just asked to rate a business's service from 1 to 5 stars. " +
      "Translate their reply into that 1-5 scale based on sentiment, or pick " +
      "the number they most likely meant if their message names more than " +
      "one. Respond with ONLY a single digit 1-5, or the word NONE if the " +
      "reply doesn't express any opinion about the service (e.g. it's " +
      "off-topic or asks a question instead).";

  const userContent = priorMessage
    ? `First message: "${priorMessage.trim().slice(0, 300)}"\nSecond message: "${trimmed}"`
    : trimmed;

  try {
    const result = await callAi({
      maxTokens: 5,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });
    const out = result.text.trim();
    return /^[1-5]$/.test(out) ? Number(out) : null;
  } catch (err) {
    console.warn("[reviews/rating-reply] disambiguation failed", err);
    return null;
  }
}

function toMillis(v: unknown): number | null {
  const maybe = v as { toMillis?: () => number } | null | undefined;
  return maybe && typeof maybe.toMillis === "function" ? maybe.toMillis() : null;
}

function confirmQuestion(rating: number): string {
  return `Just to confirm — that sounds like a ${rating}/5, is that right? Reply YES or give a number 1-5.`;
}

const CLEAR_PENDING_STATE = {
  awaitingReviewReplyAt: FieldValue.delete(),
  awaitingReviewReplyAttempts: FieldValue.delete(),
  pendingRatingHoldValue: FieldValue.delete(),
  pendingRatingHoldMessage: FieldValue.delete(),
  pendingRatingConfirm: FieldValue.delete(),
};

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

  const awaitingMs = toMillis(input.contact.awaitingReviewReplyAt);
  if (!awaitingMs || Date.now() - awaitingMs > RATING_REPLY_WINDOW_MS) {
    return { handled: false };
  }

  if (input.contact.pendingRatingConfirm != null) {
    return handleConfirmReply(input, input.contact.pendingRatingConfirm);
  }
  if (input.contact.pendingRatingHoldValue != null) {
    return handleDuringHold(input, input.contact.pendingRatingHoldValue);
  }
  return classifyFreshReply(input);
}

/** No pending state yet — this is the customer's first reply since the ask. */
async function classifyFreshReply(
  input: RatingReplyInput,
): Promise<RatingReplyResult> {
  const digits = extractAllExplicitRatings(input.body);

  if (digits.length === 1) {
    await startHold(input, digits[0]);
    return { handled: true };
  }

  // 2+ digits, or none at all — genuinely ambiguous, ask the AI.
  const candidate = await disambiguateRating(input.body);
  if (candidate !== null) {
    await askForConfirmation(input, candidate);
    return { handled: true };
  }
  return giveUpOrRetry(input);
}

/** A clean single digit is being held; a new reply arrived during the window. */
async function handleDuringHold(
  input: RatingReplyInput,
  heldValue: number,
): Promise<RatingReplyResult> {
  const digits = extractAllExplicitRatings(input.body);

  if (digits.length === 0) {
    // Unrelated chatter during the hold — don't perturb it, let the
    // scheduled commit proceed and let this message fall through to
    // normal handling (e.g. the general AI chatbot, if enabled).
    return { handled: false };
  }
  if (digits.length === 1 && digits[0] === heldValue) {
    // Reinforcement ("5" again, or "yes 5") — consume it silently.
    return { handled: true };
  }

  // A different digit (or multiple digits) arrived — the "two different
  // messages back to back" case. Ask AI to weigh both messages, favoring
  // the more recent one, then confirm with the customer either way.
  const heldMessage = input.contact.pendingRatingHoldMessage ?? "";
  const candidate =
    (await disambiguateRating(input.body, heldMessage)) ??
    digits[digits.length - 1]; // AI unsure — default to the newest digit.
  await askForConfirmation(input, candidate);
  return { handled: true };
}

/** An AI-proposed (or conflict-disambiguated) rating is awaiting confirmation. */
async function handleConfirmReply(
  input: RatingReplyInput,
  candidate: number,
): Promise<RatingReplyResult> {
  if (isAffirmative(input.body)) {
    await commitRating(input, candidate);
    return { handled: true, rating: candidate };
  }

  const digits = extractAllExplicitRatings(input.body);
  if (digits.length === 1) {
    // An explicit number always wins over a proposed candidate.
    await commitRating(input, digits[0]);
    return { handled: true, rating: digits[0] };
  }

  if (isNegative(input.body)) {
    await getAdminDb()
      .doc(`contacts/${input.contact.id}`)
      .set(
        {
          pendingRatingConfirm: FieldValue.delete(),
          awaitingReviewReplyAttempts: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    await sendPlainText(
      input,
      "No worries — what number would you give us, 1-5?",
    );
    return { handled: true };
  }

  return giveUpOrRetry(input, () => confirmQuestion(candidate));
}

/** Starts the RATING_HOLD_WINDOW_SEC hold for a clean, unambiguous digit. */
async function startHold(input: RatingReplyInput, rating: number): Promise<void> {
  await getAdminDb()
    .doc(`contacts/${input.contact.id}`)
    .set(
      {
        pendingRatingHoldValue: rating,
        pendingRatingHoldMessage: input.body.slice(0, 500),
        awaitingReviewReplyAttempts: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  const queued = await publishCallback({
    pathname: "/api/webhooks/reviews/commit-rating",
    body: {
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      contactId: input.contact.id,
      expectedValue: rating,
    },
    delaySeconds: RATING_HOLD_WINDOW_SEC,
    deduplicationId: `rating_hold_${input.contact.id}_${Date.now()}`,
  });

  if (!queued) {
    // QStash isn't configured or the enqueue failed — commit immediately
    // rather than stranding the customer with a hold that never resolves.
    await commitRating(input, rating);
  }
}

/** Sends the confirm question and parks the candidate for the next reply. */
async function askForConfirmation(
  input: RatingReplyInput,
  candidate: number,
): Promise<void> {
  await getAdminDb()
    .doc(`contacts/${input.contact.id}`)
    .set(
      {
        pendingRatingConfirm: candidate,
        pendingRatingHoldValue: FieldValue.delete(),
        pendingRatingHoldMessage: FieldValue.delete(),
        awaitingReviewReplyAttempts: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  await sendPlainText(input, confirmQuestion(candidate));
}

/** Ambiguous reply, no readable rating at all — retry a few times before
 *  giving up on the gate entirely (mirrors the original tolerant-of-typos
 *  behavior). `resendQuestion`, when given, re-asks the same question
 *  instead of silently waiting (used from the confirm state). */
async function giveUpOrRetry(
  input: RatingReplyInput,
  resendQuestion?: () => string,
): Promise<RatingReplyResult> {
  const attempts = (input.contact.awaitingReviewReplyAttempts ?? 0) + 1;
  if (attempts >= MAX_RATING_REPLY_ATTEMPTS) {
    await getAdminDb()
      .doc(`contacts/${input.contact.id}`)
      .set(
        { ...CLEAR_PENDING_STATE, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    return { handled: false };
  }
  await getAdminDb()
    .doc(`contacts/${input.contact.id}`)
    .set(
      { awaitingReviewReplyAttempts: attempts, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  if (resendQuestion) {
    await sendPlainText(input, resendQuestion());
    return { handled: true };
  }
  return { handled: false };
}

/** Bare-bones outbound send + persist, for the confirm/re-ask questions
 *  (not the final Google-link/apology outcome — see commitRating for that). */
async function sendPlainText(input: RatingReplyInput, body: string): Promise<void> {
  try {
    const res = await sendSmsForSubAccount({
      subAccountId: input.subAccountId,
      subAccount: input.subAccount,
      to: input.contact.phone,
      body,
    });
    const db = getAdminDb();
    await db
      .collection("contacts")
      .doc(input.contact.id)
      .collection("messages")
      .doc(res.sid)
      .set({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        contactId: input.contact.id,
        direction: "outbound",
        status: "sent",
        body,
        from: res.from,
        to: input.contact.phone,
        twilioMessageSid: res.sid,
        sentByUid: "review-rating-reply",
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    await upsertConversationForMessage({
      contactId: input.contact.id,
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      contactName: input.contact.name ?? "",
      contactPhone: input.contact.phone,
      channel: "sms",
      direction: "outbound",
      body,
    });
  } catch (err) {
    console.warn("[reviews/rating-reply] plain-text send failed", err);
  }
}

/**
 * Final resolution — the rating is now treated as definitive. Clears every
 * pending-state field, sends the Google link (4-5) or the internal
 * feedback message (1-3), persists it, logs the activity, resumes any
 * paused Workflow Builder run, and fires the low-rating Task/email.
 * Exported so the QStash hold-commit callback can call it directly.
 */
export async function commitRating(
  input: RatingReplyInput,
  rating: number,
): Promise<void> {
  const cfg = input.subAccount.googleReviewConfig;
  if (!cfg) return; // Gate got turned off mid-flight — nothing to send.

  const db = getAdminDb();
  await db.doc(`contacts/${input.contact.id}`).set(
    {
      ...CLEAR_PENDING_STATE,
      pendingReviewWorkflowRunId: FieldValue.delete(),
      lastReviewRating: rating,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (input.contact.pendingReviewWorkflowRunId) {
    void resumeReviewRatingRun(input.contact.pendingReviewWorkflowRunId, {
      rating,
      positive: rating >= 4,
    });
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
