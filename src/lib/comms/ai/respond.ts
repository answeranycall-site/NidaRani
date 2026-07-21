import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  sendSmsForSubAccount,
  sendWhatsappForSubAccount,
} from "@/lib/comms/twilio";
import { callAi, type AiChatMessage } from "@/lib/comms/ai/openrouter";
import {
  incrementChannelTokens,
  type ConfiguredChannelId,
} from "@/lib/comms/ai/agent";
import { publishCallback } from "@/lib/automations/qstash";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import {
  matchEscalationKeyword,
  sendEscalationNotification,
} from "@/lib/comms/ai/escalation";
import type { ResolvedAiAgent } from "@/types/ai";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import {
  getConversationControls,
  setConversationDraft,
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import type { ConversationChannel } from "@/types/conversations";

interface RespondInput {
  subAccountId: string;
  subAccount: SubAccountDoc;
  /** Profile + channel config, already merged into effective values by
   *  the webhook caller via resolveAgent(). */
  agent: ResolvedAiAgent;
  /** Which channel this respond run is for. Supported here: "sms" and
   *  "whatsapp" — both ride Twilio with the same guards → context → LLM →
   *  send → log flow, differing only in transport (see getChannelTransport).
   *  web-chat + voice have their own orchestrators and never call this. */
  channelId: ConfiguredChannelId;
  contact: Contact;
  /** The just-arrived inbound text. */
  incomingMessage: string;
  /** Caller's twilio "From" — needed for the outbound reply destination. */
  contactPhone: string;
}

type AiSkipReason =
  | "disabled"
  | "no_prompt"
  | "outside_hours"
  | "escalation_keyword"
  | "contact_opted_out"
  | "bot_off"
  | "bot_paused"
  | "llm_failed";

type RespondOutcome =
  | { kind: "replied"; replyText: string; tokens: number }
  | { kind: "delayed"; replyText: string; tokens: number; delaySeconds: number }
  | { kind: "escalated"; keyword: string }
  | { kind: "drafted"; replyText: string; tokens: number }
  | { kind: "skipped"; reason: AiSkipReason };

/**
 * Per-channel transport. The orchestrator is identical across SMS + WhatsApp;
 * only the message-thread subcollection, the opt-out flag, the provider send,
 * and the activity label differ. Centralising those four here keeps a single
 * orchestrator instead of one near-duplicate per channel.
 */
interface ChannelTransport {
  /** Subcollection under contacts/{id} where this channel's thread lives. */
  messagesCollection: string;
  /** Human label used in activity-log lines ("SMS" / "WhatsApp"). */
  label: string;
  /** Per-channel opt-out flag check. */
  isOptedOut: (contact: Contact) => boolean;
  /** Send the reply; returns the provider message id + the from address. */
  send: (args: {
    subAccountId: string;
    subAccount: SubAccountDoc;
    to: string;
    body: string;
  }) => Promise<{ sid: string; from: string }>;
}

function getChannelTransport(channelId: ConfiguredChannelId): ChannelTransport {
  if (channelId === "whatsapp") {
    // NB: no 24-hour session-window guard here. This orchestrator only ever
    // fires in response to a just-received inbound WhatsApp message, so the
    // window is always open. The window IS enforced on the manual-send path
    // (/api/comms/whatsapp/send), where an operator could try to message a
    // contact who hasn't written in for >24h (templates required — a v2 add).
    return {
      messagesCollection: "whatsappMessages",
      label: "WhatsApp",
      isOptedOut: (c) => c.whatsappOptedOut === true,
      send: ({ subAccountId, subAccount, to, body }) =>
        sendWhatsappForSubAccount({ subAccountId, subAccount, to, body }),
    };
  }
  if (channelId === "sms") {
    return {
      messagesCollection: "messages",
      label: "SMS",
      isOptedOut: (c) => c.smsOptedOut === true,
      send: ({ subAccountId, subAccount, to, body }) =>
        sendSmsForSubAccount({ subAccountId, subAccount, to, body }).then(
          (r) => ({ sid: r.sid, from: r.from }),
        ),
    };
  }
  // web-chat + voice have dedicated orchestrators; they never reach here.
  throw new Error(
    `maybeRespondWithAi does not support channel "${channelId}".`,
  );
}

/**
 * Decides whether the current local time (in the configured timezone)
 * falls within the agent's active window. Supports overnight windows
 * (e.g. hoursStart=22, hoursEnd=6 = 10pm to 6am).
 */
function isWithinHours(
  hoursStart: number,
  hoursEnd: number,
  timezone: string,
): boolean {
  const now = new Date();
  let hour: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    hour = hourPart ? Number(hourPart.value) : now.getUTCHours();
    if (!Number.isFinite(hour)) hour = now.getUTCHours();
    if (hour === 24) hour = 0;
  } catch {
    hour = now.getUTCHours();
  }

  const start = Math.max(0, Math.min(23, Math.floor(hoursStart)));
  const end = Math.max(0, Math.min(23, Math.floor(hoursEnd)));
  if (start === end) return true; // 24/7
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

async function loadRecentHistory(
  contactId: string,
  limit: number,
  excludeBody: string,
  messagesCollection: string,
): Promise<AiChatMessage[]> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  const snap = await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection(messagesCollection)
    .orderBy("createdAt", "desc")
    .limit(safeLimit + 1)
    .get();
  const docs = snap.docs.reverse();
  const turns: AiChatMessage[] = [];
  for (const d of docs) {
    const data = d.data() as { direction?: string; body?: string };
    if (!data.body) continue;
    if (data.direction === "inbound" && data.body.trim() === excludeBody.trim()) {
      continue;
    }
    turns.push({
      role: data.direction === "outbound" ? "assistant" : "user",
      content: data.body,
    });
  }
  return turns;
}

// System prompt building moved to @/lib/comms/ai/prompt — shared with the
// web-chat orchestrator and the "Test this persona" dry-run endpoint so
// every channel sees the same string the SMS path produces.

async function logActivity({
  contactId,
  agencyId,
  subAccountId,
  type,
  content,
  meta,
}: {
  contactId: string;
  agencyId: string;
  subAccountId: string;
  type: "ai_reply_sent" | "ai_escalated" | "ai_skipped";
  content: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type,
        content,
        meta: meta ?? null,
        agencyId,
        subAccountId,
        createdBy: "ai_inbound",
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[ai/respond] activity write failed", err);
  }
}

async function storeOutboundReply({
  contactId,
  agencyId,
  subAccountId,
  body,
  from,
  to,
  twilioSid,
  messagesCollection,
}: {
  contactId: string;
  agencyId: string;
  subAccountId: string;
  body: string;
  from: string;
  to: string;
  twilioSid: string;
  messagesCollection: string;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection(messagesCollection)
      .doc(twilioSid)
      .set(
        {
          agencyId,
          subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body,
          from,
          to,
          twilioMessageSid: twilioSid,
          sentByUid: "ai",
          aiGenerated: true,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[ai/respond] outbound message write failed", err);
  }
}

export interface SendAndPersistReplyInput {
  subAccountId: string;
  subAccount: SubAccountDoc;
  agencyId: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  channelId: ConfiguredChannelId;
  replyText: string;
  model: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * The back half of the orchestrator — actually send the already-generated
 * reply + persist it (message row, Conversations index, activity log).
 * Split out so it can run either inline (no delay configured) or from the
 * QStash callback that fires `replyDelaySec` seconds later (see
 * api/webhooks/ai/delayed-send). Token counting happens at generation time
 * in the caller, NOT here, so it's counted exactly once regardless of
 * which path sends the reply.
 */
export async function sendAndPersistReply(
  input: SendAndPersistReplyInput,
): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const transport = getChannelTransport(input.channelId);

  let send;
  try {
    send = await transport.send({
      subAccountId: input.subAccountId,
      subAccount: input.subAccount,
      to: input.contactPhone,
      body: input.replyText,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[ai/respond] Twilio send failed for sa=${input.subAccountId}: ${msg}`,
    );
    await logActivity({
      contactId: input.contactId,
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      type: "ai_skipped",
      content: `AI reply generated but ${transport.label} send failed: ${msg.slice(0, 200)}`,
      meta: {
        reason: "llm_failed",
        twilioError: msg.slice(0, 500),
        channel: input.channelId,
      },
    });
    return { ok: false, error: msg };
  }

  await storeOutboundReply({
    contactId: input.contactId,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    body: input.replyText,
    from: send.from,
    to: input.contactPhone,
    twilioSid: send.sid,
    messagesCollection: transport.messagesCollection,
  });

  await upsertConversationForMessage({
    contactId: input.contactId,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    channel: input.channelId as ConversationChannel,
    direction: "outbound",
    body: input.replyText,
  });

  await logActivity({
    contactId: input.contactId,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    type: "ai_reply_sent",
    content: `AI replied via ${transport.label} (${input.totalTokens} tokens, ${input.model}).`,
    meta: {
      channel: input.channelId,
      model: input.model,
      tokens: input.totalTokens,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      twilioSid: send.sid,
    },
  });

  return { ok: true, sid: send.sid };
}

/**
 * Schedules the send `delaySeconds` out via QStash instead of sending
 * inline — the inbound webhook returns immediately either way, so this
 * never risks Twilio's own webhook timeout. Returns false when QStash
 * isn't configured or the publish call fails; the caller falls back to
 * sending immediately rather than silently dropping the reply.
 */
async function queueDelayedReply(
  input: SendAndPersistReplyInput & { delaySeconds: number },
): Promise<boolean> {
  const { delaySeconds, ...payload } = input;
  const res = await publishCallback({
    pathname: "/api/webhooks/ai/delayed-send",
    body: payload,
    delaySeconds,
    deduplicationId: `ai_delayed_${input.contactId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
  return !!res;
}

/**
 * Main orchestrator. Webhook caller already resolved profile + channel
 * into a ResolvedAiAgent via resolveAgent() — this function just
 * orchestrates the guards → context → LLM → send → log flow.
 */
export async function maybeRespondWithAi(
  input: RespondInput,
): Promise<RespondOutcome> {
  const {
    subAccountId,
    subAccount,
    agent,
    channelId,
    contact,
    incomingMessage,
    contactPhone,
  } = input;
  const eff = agent.effective;
  const transport = getChannelTransport(channelId);

  // Guard: contact is opted out of this channel.
  if (transport.isOptedOut(contact)) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — contact is ${transport.label}-opted-out.`,
      meta: { reason: "contact_opted_out", channel: channelId },
    });
    return { kind: "skipped", reason: "contact_opted_out" };
  }

  // Guard: profile prompt blank — refuse to send anything.
  if (!eff.systemPrompt.trim()) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — agent persona prompt is empty.",
      meta: { reason: "no_prompt" },
    });
    return { kind: "skipped", reason: "no_prompt" };
  }

  // Guard: outside configured business hours.
  if (!isWithinHours(eff.hoursStart, eff.hoursEnd, eff.timezone)) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — outside business hours (${eff.hoursStart}:00–${eff.hoursEnd}:00 ${eff.timezone}).`,
      meta: { reason: "outside_hours" },
    });
    return { kind: "skipped", reason: "outside_hours" };
  }

  // Guard: escalation keyword in the inbound text.
  const triggered = matchEscalationKeyword(
    incomingMessage,
    eff.escalationKeywords,
  );
  if (triggered) {
    if (eff.escalationNotifyEmail) {
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
      await sendEscalationNotification({
        to: eff.escalationNotifyEmail,
        businessName:
          eff.businessName.trim() || subAccount.name || "your business",
        contactName: contact.name || "(unnamed)",
        contactPhone,
        contactId: contact.id,
        subAccountId,
        triggeredKeyword: triggered,
        incomingMessage,
        appUrl,
      });
    }
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_escalated",
      content: `AI escalated to human — keyword "${triggered}" matched in inbound message.`,
      meta: { reason: "escalation_keyword", keyword: triggered, channel: channelId },
    });
    return { kind: "escalated", keyword: triggered };
  }

  // Per-conversation AI controls (unified inbox). Layered ON TOP of the
  // channel-level `enabled` gate the webhook already checked. Pause wins over
  // mode. Defaults to auto/not-paused for legacy conversations.
  const controls = await getConversationControls(contact.id);
  if (controls.botPausedUntilMs && controls.botPausedUntilMs > Date.now()) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — bot paused after a human took over.",
      meta: { reason: "bot_paused", channel: channelId },
    });
    return { kind: "skipped", reason: "bot_paused" };
  }
  if (controls.botMode === "off") {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — bot turned off for this conversation.",
      meta: { reason: "bot_off", channel: channelId },
    });
    return { kind: "skipped", reason: "bot_off" };
  }
  const suggestOnly = controls.botMode === "suggest";

  // Build LLM context and call the model.
  let completion;
  try {
    const [history, contextBlock] = await Promise.all([
      loadRecentHistory(
        contact.id,
        eff.contextMessageCount,
        incomingMessage,
        transport.messagesCollection,
      ),
      buildContactContextBlock(contact).catch((err) => {
        console.warn(
          `[ai/respond] context block build failed for ${contact.id}`,
          err,
        );
        return null;
      }),
    ]);
    const systemPrompt = buildSystemPrompt({
      agent,
      channelId,
      fallbackBusinessName: subAccount.name ?? "the business",
      contactContextBlock: contextBlock,
    });
    const messages: AiChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: incomingMessage },
    ];
    completion = await callAi({
      model: eff.modelOverride ?? undefined,
      messages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[ai/respond] LLM call failed for sa=${subAccountId}: ${msg}`);
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — LLM call failed: ${msg.slice(0, 200)}`,
      meta: { reason: "llm_failed", error: msg.slice(0, 500) },
    });
    return { kind: "skipped", reason: "llm_failed" };
  }

  // Suggest mode: stash the generated reply for a human to approve/edit in the
  // inbox instead of sending it. Tokens were spent, so still count them.
  if (suggestOnly) {
    await setConversationDraft({
      contactId: contact.id,
      subAccountId,
      agencyId: subAccount.agencyId,
      contactName: contact.name ?? "",
      contactPhone: contact.phone ?? contactPhone,
      channel: channelId as ConversationChannel,
      body: completion.text,
      model: completion.model,
      tokens: completion.totalTokens,
    });
    void incrementChannelTokens(subAccountId, channelId, completion.totalTokens);
    return {
      kind: "drafted",
      replyText: completion.text,
      tokens: completion.totalTokens,
    };
  }

  // Tokens were spent generating the reply regardless of when/how it's
  // actually sent — count them once, here, rather than in both the
  // immediate and delayed send paths below.
  void incrementChannelTokens(subAccountId, channelId, completion.totalTokens);

  const replyPayload = {
    subAccountId,
    subAccount,
    agencyId: subAccount.agencyId,
    contactId: contact.id,
    contactName: contact.name ?? "",
    contactPhone: contact.phone ?? contactPhone,
    channelId,
    replyText: completion.text,
    model: completion.model,
    totalTokens: completion.totalTokens,
    promptTokens: completion.promptTokens,
    completionTokens: completion.completionTokens,
  };

  // Cosmetic "typing delay" — schedule the actual send via QStash instead
  // of sending inline, so the bot doesn't feel instantaneous. The inbound
  // webhook has already returned by the time this fires; nothing here
  // blocks Twilio's response.
  if (eff.replyDelaySec > 0) {
    const queued = await queueDelayedReply({
      ...replyPayload,
      delaySeconds: eff.replyDelaySec,
    });
    if (queued) {
      return {
        kind: "delayed",
        replyText: completion.text,
        tokens: completion.totalTokens,
        delaySeconds: eff.replyDelaySec,
      };
    }
    // QStash enqueue failed (not configured, or a transient error) — fail
    // safe by sending immediately below rather than silently dropping it.
  }

  const sent = await sendAndPersistReply(replyPayload);
  if (!sent.ok) {
    return { kind: "skipped", reason: "llm_failed" };
  }

  return {
    kind: "replied",
    replyText: completion.text,
    tokens: completion.totalTokens,
  };
}
