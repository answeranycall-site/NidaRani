import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type {
  ConversationBotMode,
  ConversationChannel,
  ConversationDraftIntent,
  ConversationDraftSlotOption,
} from "@/types/conversations";

/**
 * How long a manual (human) reply pauses the bot on that conversation. The
 * pause auto-expires; the operator can also Resume it from the inbox. Keeps the
 * AI from jumping back into a thread a human is actively handling.
 */
const PAUSE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Server-side write for the unified-inbox index. Called right after every
 * message-row write (SMS/WhatsApp, inbound + outbound). Best-effort: a failure
 * here must never break the underlying send/receive, so every call is wrapped
 * and the originating route `void`s it or ignores the resolved promise.
 *
 * Doc id == contactId (one conversation per contact). A get-or-create
 * transaction stamps the immutable fields once (createdAt, status, botMode),
 * then merges the rolling state (preview, lastChannel, lastMessageAt) and, for
 * inbound, increments unreadCount.
 */

const PREVIEW_MAX = 120;

export interface UpsertConversationInput {
  contactId: string;
  subAccountId: string;
  agencyId: string;
  /** Denormalized onto the conversation for the list view. */
  contactName: string;
  contactPhone: string | null;
  channel: ConversationChannel;
  direction: "inbound" | "outbound";
  body: string;
  /**
   * True when this is a genuinely human-authored outbound reply — typed
   * fresh into the contact profile or Conversations composer, NOT an
   * approved AI draft. Pauses the bot for PAUSE_WINDOW_MS so the AI doesn't
   * talk over a human who just took over the thread. The bot's own replies,
   * and a human approving an AI draft as-is, both pass this false — see
   * `clearDraft` for the latter case.
   */
  pauseBot?: boolean;
  /**
   * True when this outbound send resolves an existing `pendingDraft` on the
   * conversation (approved from the Conversations tab), whether or not the
   * operator edited the text first. Clears the draft + resets unread WITHOUT
   * pausing the bot — approving a suggestion is the product working as
   * designed, not a human overriding the AI. `pauseBot: true` implies this
   * too, so routes only need to set one or the other, never both.
   */
  clearDraft?: boolean;
}

export async function upsertConversationForMessage(
  input: UpsertConversationInput,
): Promise<void> {
  try {
    const db = getAdminDb();
    const ref = db.collection("conversations").doc(input.contactId);
    const preview =
      input.body.length > PREVIEW_MAX
        ? `${input.body.slice(0, PREVIEW_MAX)}…`
        : input.body;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      const patch: Record<string, unknown> = {
        contactId: input.contactId,
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        channelsSeen: FieldValue.arrayUnion(input.channel),
        lastChannel: input.channel,
        lastDirection: input.direction,
        lastMessagePreview: preview,
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (input.direction === "inbound") {
        // increment() on a missing field initializes it to 1.
        patch.unreadCount = FieldValue.increment(1);
      }

      if (input.pauseBot) {
        // A human took over: pause the bot, mark read, drop any stale draft.
        patch.botPausedUntil = new Date(Date.now() + PAUSE_WINDOW_MS);
        patch.unreadCount = 0;
        patch.pendingDraft = null;
      } else if (input.clearDraft) {
        // An AI draft was approved and sent — mark read, drop the now-stale
        // draft field, but do NOT pause. The bot should keep replying to
        // this contact's next message exactly as before the approval.
        patch.unreadCount = 0;
        patch.pendingDraft = null;
      }

      if (!snap.exists) {
        // Stamp immutable defaults once. botMode reads the sub-account's
        // aiAgent/profile.autoSendEnabled — undefined/false (the standard,
        // see AiAgentProfile's doc comment) means brand-new conversations
        // start in "suggest" mode; an explicit opt-in starts them in "auto".
        // Only read for a first-ever message — every subsequent upsert on
        // this conversation skips straight to the merge patch below.
        const profileSnap = await tx.get(
          db.doc(`subAccounts/${input.subAccountId}/aiAgent/profile`),
        );
        const autoSendEnabled = profileSnap.data()?.autoSendEnabled === true;

        patch.createdAt = FieldValue.serverTimestamp();
        patch.status = "open";
        patch.assigneeUid = null;
        patch.botMode = autoSendEnabled ? "auto" : "suggest";
        patch.botPausedUntil = null;
        // First-ever message is outbound → no unread yet.
        if (input.direction !== "inbound") patch.unreadCount = 0;
      }

      tx.set(ref, patch, { merge: true });
    });
  } catch (err) {
    console.warn("[conversations/upsert] failed", err);
  }
}

/**
 * Read the AI controls the orchestrator needs to decide whether/how to reply.
 * Defaults to "auto" + not-paused when the doc or fields are missing, so legacy
 * conversations keep auto-replying exactly as before.
 */
export async function getConversationControls(
  contactId: string,
): Promise<{ botMode: ConversationBotMode; botPausedUntilMs: number | null }> {
  try {
    const snap = await getAdminDb()
      .collection("conversations")
      .doc(contactId)
      .get();
    if (!snap.exists) return { botMode: "auto", botPausedUntilMs: null };
    const d = snap.data() ?? {};
    const botMode = (d.botMode as ConversationBotMode) ?? "auto";
    const bp = d.botPausedUntil as { toMillis?: () => number } | null | undefined;
    const botPausedUntilMs =
      bp && typeof bp.toMillis === "function" ? bp.toMillis() : null;
    return { botMode, botPausedUntilMs };
  } catch (err) {
    console.warn("[conversations/controls] read failed", err);
    return { botMode: "auto", botPausedUntilMs: null };
  }
}

/**
 * Write a suggest-mode draft onto the conversation for a human to approve.
 * The conversation already exists (the inbound upsert ran first), but we carry
 * the tenancy + denorm fields anyway for safety.
 */
export async function setConversationDraft(input: {
  contactId: string;
  subAccountId: string;
  agencyId: string;
  contactName: string;
  contactPhone: string | null;
  channel: ConversationChannel;
  body: string;
  model: string;
  tokens: number;
  /** Set only for a draft written by a paused Workflow Builder run (the AI
   *  Booking + Nurture chain) — see `lib/workflows/engine.ts::
   *  armApprovalWait`. Absent for ordinary suggest-mode replies. */
  workflowRunId?: string | null;
  /** Absent = ordinary "reply" draft. */
  intent?: ConversationDraftIntent;
  /** Only meaningful when `intent === "booking_proposal"`. */
  bookingSlotOptions?: ConversationDraftSlotOption[] | null;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("conversations")
      .doc(input.contactId)
      .set(
        {
          contactId: input.contactId,
          subAccountId: input.subAccountId,
          agencyId: input.agencyId,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          pendingDraft: {
            body: input.body,
            channel: input.channel,
            model: input.model,
            tokens: input.tokens,
            createdAt: FieldValue.serverTimestamp(),
            workflowRunId: input.workflowRunId ?? null,
            intent: input.intent ?? "reply",
            bookingSlotOptions: input.bookingSlotOptions ?? null,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[conversations/draft] write failed", err);
  }
}
