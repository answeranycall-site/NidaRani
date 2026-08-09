import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import {
  setConversationDraft,
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import {
  createBookingTransactionally,
  SlotConflict,
} from "@/lib/booking/create-booking";
import { buildEventPublicUrl } from "@/lib/booking/event-token";
import {
  emitBookingWebhook,
  fireBookingTrigger,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import { resumeAiBookingRun } from "@/lib/workflows/engine";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { BookingPage } from "@/types/booking";

/**
 * Reply-interception for the AI Booking + Nurture SMS flow (sibling to
 * `lib/reviews/rating-reply.ts`). Called from the inbound Twilio webhook
 * (dedicated mode only — a self-book flow needs the sub-account's own
 * number) right before `maybeHandleRatingReply` and the generic AI
 * auto-reply fallback.
 *
 * Only acts when `contact.pendingBookingWorkflowRunId` is live — stamped by
 * the Workflow Builder `ai_await_booking_reply` node the moment an
 * AI-drafted proposal is approved and actually sends (see
 * `lib/workflows/engine.ts`). Classifies the reply against the exact slots
 * that were offered, books the Event immediately on a match (mirrors the
 * public booking page's zero-approval behavior — see the plan's "approval
 * gates text, not the calendar write" decision), drafts a confirmation text
 * for approval, and resumes the paused workflow run.
 *
 * A generous fixed cap bounds how long a reply is still readable as a
 * booking pick — the workflow's own configurable `replyTimeoutSeconds` on
 * `ai_propose_booking` is the AUTHORITATIVE expiry (it's what actually
 * times the run out via QStash); this is just a belt-and-suspenders guard
 * against stale contact-doc state.
 */
const BOOKING_REPLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface AiBookingReplyInput {
  subAccountId: string;
  agencyId: string;
  contact: Contact;
  subAccount: SubAccountDoc;
  body: string;
}

export interface AiBookingReplyResult {
  handled: boolean;
}

function toMillis(v: unknown): number | null {
  const maybe = v as { toMillis?: () => number } | null | undefined;
  return maybe && typeof maybe.toMillis === "function" ? maybe.toMillis() : null;
}

function toDate(v: unknown): Date | null {
  const maybe = v as { toDate?: () => Date } | null | undefined;
  return maybe && typeof maybe.toDate === "function" ? maybe.toDate() : null;
}

const CLEAR_PENDING_BOOKING = {
  pendingBookingWorkflowRunId: FieldValue.delete(),
  pendingBookingPageId: FieldValue.delete(),
  pendingBookingSlotOptions: FieldValue.delete(),
  pendingBookingRepliesArmedAt: FieldValue.delete(),
  pendingWorkflowApprovalRunId: FieldValue.delete(),
};

export async function maybeHandleAiBookingReply(
  input: AiBookingReplyInput,
): Promise<AiBookingReplyResult> {
  const armedMs = toMillis(input.contact.pendingBookingRepliesArmedAt);
  if (!input.contact.pendingBookingWorkflowRunId || !armedMs) {
    return { handled: false };
  }
  if (Date.now() - armedMs > BOOKING_REPLY_WINDOW_MS) {
    await getAdminDb()
      .doc(`contacts/${input.contact.id}`)
      .set(
        { ...CLEAR_PENDING_BOOKING, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    return { handled: false };
  }

  const options = input.contact.pendingBookingSlotOptions ?? [];
  const pageId = input.contact.pendingBookingPageId;
  if (options.length === 0 || !pageId) return { handled: false };

  const pick = await classifyPick(
    input.body,
    options.map((o) => o.label),
  );

  if (pick === "unreadable") {
    await sendPlainText(
      input,
      "Sorry, I didn't catch that — reply with the number of the time that works, or say none work.",
    );
    return { handled: true };
  }
  if (pick === "decline") {
    await resolveNotBooked(input, "declined");
    return { handled: true };
  }

  const chosen = options[pick];
  const startAt = toDate(chosen.startAt);
  const endAt = toDate(chosen.endAt);
  if (!startAt || !endAt) {
    await resolveNotBooked(input, "invalid_slot");
    return { handled: true };
  }

  const pageSnap = await getAdminDb()
    .doc(`subAccounts/${input.subAccountId}/bookingPages/${pageId}`)
    .get();
  if (!pageSnap.exists) {
    await resolveNotBooked(input, "page_missing");
    return { handled: true };
  }
  const page = pageSnap.data() as BookingPage;

  try {
    const created = await createBookingTransactionally({
      saId: input.subAccountId,
      agencyId: input.agencyId,
      page,
      sub: input.subAccount,
      slotStart: startAt,
      slotEnd: endAt,
      contact: {
        id: input.contact.id,
        name: input.contact.name,
        email: input.contact.email,
        phone: input.contact.phone,
      },
      source: "ai_workflow",
    });

    const runId = input.contact.pendingBookingWorkflowRunId;
    await getAdminDb()
      .doc(`contacts/${input.contact.id}`)
      .set(
        { ...CLEAR_PENDING_BOOKING, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );

    // Reuse the exact same post-write side effects the public booking route
    // fires, so an AI-initiated booking is indistinguishable downstream —
    // this is what keeps the existing 24h/1h reminder workflow + outbound
    // webhooks working unchanged.
    if (page.remindersEnabled) {
      await scheduleEventReminders({
        eventId: created.eventDocRef.id,
        startAt,
        reminderOffsetsMinutes: page.reminderOffsetsMinutes,
        rawToken: created.rawToken,
        pendingPayment: false,
      });
    }
    await recordBookingActivity(
      {
        id: created.eventDocRef.id,
        title: created.title,
        contactId: input.contact.id,
        bookingPageSlug: page.slug,
      },
      "booking_page_booked",
    );

    const displayTime = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: page.timezone,
      timeZoneName: "short",
    }).format(startAt);
    const publicEventUrl = buildEventPublicUrl(created.rawToken);

    void fireBookingTrigger(
      {
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        contactId: input.contact.id,
      },
      "event_booked",
      { time: displayTime, title: created.title, rescheduleLink: publicEventUrl },
    );
    void emitBookingWebhook({
      eventId: created.eventDocRef.id,
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      type: "booking_page_booked",
    });

    // Confirmation text queues for approval like every other AI-drafted
    // message in this flow — standalone (workflowRunId null), since nothing
    // in the run needs to wait on IT specifically; the resolver already
    // branches whenTrue the moment the Event exists (below).
    await draftConfirmation(input, {
      businessName: input.subAccount.name ?? "",
      displayTime,
      publicEventUrl,
    });

    if (runId) {
      void resumeAiBookingRun(runId, {
        eventId: created.eventDocRef.id,
        startAtIso: startAt.toISOString(),
        endAtIso: endAt.toISOString(),
      });
    }
    return { handled: true };
  } catch (err) {
    if (err instanceof SlotConflict) {
      await sendPlainText(
        input,
        "Sorry, that time was just taken. Someone from our team will follow up with other options.",
      );
      await resolveNotBooked(input, "slot_conflict");
      return { handled: true };
    }
    console.error("[booking/ai-booking-reply] booking failed", err);
    return { handled: false };
  }
}

/** Clears pending-booking state + resumes the paused run down `whenFalse`. */
async function resolveNotBooked(
  input: AiBookingReplyInput,
  reason: string,
): Promise<void> {
  const runId = input.contact.pendingBookingWorkflowRunId;
  await getAdminDb()
    .doc(`contacts/${input.contact.id}`)
    .set(
      { ...CLEAR_PENDING_BOOKING, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  if (runId) void resumeAiBookingRun(runId, null);
  console.warn(
    `[booking/ai-booking-reply] not booked (${reason}) contact=${input.contact.id}`,
  );
}

type PickResult = number | "decline" | "unreadable";

/** A single digit 1-N referencing the offered slots, word-boundary guarded
 *  so a phone number or price in the reply can't be misread as a pick. */
function extractDigitPick(body: string, count: number): number | null {
  const m = body.trim().match(/\b([1-9])\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= count ? n - 1 : null;
}

function isDeclineText(body: string): boolean {
  const t = body.trim().toLowerCase();
  return (
    /^(no|nope|nah|none)$/.test(t) ||
    /\b(none of (those|them|these)|neither|not available|no thanks|don'?t work|can'?t make (it|any))\b/.test(
      t,
    )
  );
}

/**
 * Resolve a reply into an offered-slot index, a decline, or unreadable.
 * Mirrors `lib/reviews/rating-reply.ts::disambiguateRating`'s precedence —
 * an explicit, in-range digit always wins deterministically; the LLM only
 * gets involved for genuinely ambiguous free text.
 */
async function classifyPick(body: string, labels: string[]): Promise<PickResult> {
  const digit = extractDigitPick(body, labels.length);
  if (digit !== null) return digit;
  if (isDeclineText(body)) return "decline";
  if (!aiIsConfigured()) return "unreadable";

  const listText = labels.map((l, i) => `${i + 1}) ${l}`).join("\n");
  try {
    const result = await callAi({
      maxTokens: 5,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            `A lead was offered these appointment times:\n${listText}\n` +
            `Read their reply and decide which one they picked. Respond with ` +
            `ONLY the number (1-${labels.length}), or NONE if they declined ` +
            `all of them, or UNCLEAR if the reply doesn't answer the question.`,
        },
        { role: "user", content: body.trim().slice(0, 300) },
      ],
    });
    const out = result.text.trim().toUpperCase();
    if (out === "NONE") return "decline";
    const n = Number(out);
    if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1;
    return "unreadable";
  } catch (err) {
    console.warn("[booking/ai-booking-reply] disambiguation failed", err);
    return "unreadable";
  }
}

/** Drafts the booking-confirmation SMS for operator approval — falls back
 *  to a plain templated confirmation if the LLM call fails or isn't
 *  configured, so a confirmation always queues even without AI. */
async function draftConfirmation(
  input: AiBookingReplyInput,
  info: { businessName: string; displayTime: string; publicEventUrl: string },
): Promise<void> {
  let body = `You're booked for ${info.displayTime}! Reply here if you need to reschedule: ${info.publicEventUrl}`;
  let model = "template";
  let tokens = 0;
  if (aiIsConfigured()) {
    try {
      const completion = await callAi({
        maxTokens: 150,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              `Draft a short, warm confirmation SMS on behalf of ${info.businessName || "our team"} ` +
              `for an appointment booked at ${info.displayTime}. Include this reschedule/cancel link ` +
              `verbatim: ${info.publicEventUrl}. Under 320 characters, no emoji, no markdown.`,
          },
          { role: "user", content: "Draft the confirmation now." },
        ],
      });
      if (completion.text.trim()) {
        body = completion.text.trim();
        model = completion.model;
        tokens = completion.totalTokens;
      }
    } catch (err) {
      console.warn(
        "[booking/ai-booking-reply] confirmation draft failed, using template fallback",
        err,
      );
    }
  }
  await setConversationDraft({
    contactId: input.contact.id,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactName: input.contact.name ?? "",
    contactPhone: input.contact.phone,
    channel: "sms",
    body,
    model,
    tokens,
    workflowRunId: null,
    intent: "booking_confirmation",
  });
}

/** Bare-bones outbound send + persist, for the mechanical nudge/decline-ack
 *  sends only (never the confirmation, which always goes through approval).
 *  Mirrors `lib/reviews/rating-reply.ts::sendPlainText`. */
async function sendPlainText(input: AiBookingReplyInput, body: string): Promise<void> {
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
        sentByUid: "ai-booking-reply",
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
    console.warn("[booking/ai-booking-reply] plain-text send failed", err);
  }
}
