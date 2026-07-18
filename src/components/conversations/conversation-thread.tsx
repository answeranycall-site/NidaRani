"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { CheckCheck, Phone, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { getFirebaseDb } from "@/lib/firebase/client";
import { subscribeToVoiceCalls } from "@/lib/firestore/voice-calls";
import { toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSubAccount } from "@/context/sub-account-context";
import type { MessageDoc } from "@/types/messages";
import type { VoiceCall } from "@/types/voice";
import type { ConversationChannel } from "@/types/conversations";
import type { ConversationTheme } from "@/hooks/use-conversation-theme";

type ChannelMessage = MessageDoc & { channel: ConversationChannel };
/** A voice call rendered inline in the merged timeline, tagged so the
 *  render loop can tell it apart from a chat-channel message. */
type VoiceEntry = VoiceCall & { kind: "voice" };
type TimelineEntry = (ChannelMessage & { kind?: undefined }) | VoiceEntry;

const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

const CHANNEL_CHIP: Record<ConversationChannel, string> = {
  sms: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  whatsapp: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  messenger: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  instagram: "bg-pink-500/10 text-pink-700 dark:text-pink-400",
};

/** Meta rows carry their own channel discriminator on the doc. */
type MetaMessageDoc = MessageDoc & { channel?: ConversationChannel };

/**
 * The merged conversation timeline. Subscribes to the contact's SMS
 * (`messages`), WhatsApp (`whatsappMessages`), and BETA Meta (`metaMessages`,
 * Messenger + Instagram) subcollections, tags each row with its channel, and
 * renders one time-ordered stream. No data is moved — this is a read-time merge
 * over the existing per-contact threads.
 */
export function ConversationThread({
  contactId,
  subAccountId,
  theme = "standard",
}: {
  contactId: string;
  /**
   * Required by the `messages` (SMS) rule specifically: it authorizes off
   * fields on the message row itself (not a join to the parent contact,
   * which is what lets an "Unknown person" thread with no real contact
   * doc render at all) — and Firestore can only verify a `resource.data`
   * check on a LIST query when the query carries a matching `where`
   * clause. Without this filter, the read is denied outright even though
   * the rule and the data are both correct.
   */
  subAccountId: string;
  theme?: ConversationTheme;
}) {
  const { saPath } = useSubAccount();
  const [sms, setSms] = useState<MessageDoc[]>([]);
  const [wa, setWa] = useState<MessageDoc[]>([]);
  const [meta, setMeta] = useState<MetaMessageDoc[]>([]);
  const [calls, setCalls] = useState<VoiceCall[]>([]);
  const [smsReady, setSmsReady] = useState(false);
  const [waReady, setWaReady] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [callsReady, setCallsReady] = useState(false);
  // Surfaced instead of silently swallowed — a permission-denied or index
  // error used to just render as an empty "No messages yet" state with no
  // way to tell it apart from a genuinely empty thread.
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contactId) return;
    const db = getFirebaseDb();
    const unsubSms = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/messages`),
        where("subAccountId", "==", subAccountId),
        orderBy("createdAt", "asc"),
      ),
      (snap) => {
        setSms(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc));
        setSmsReady(true);
      },
      (err) => {
        console.error("[conversation-thread] sms subscription failed", err);
        setLoadError(`SMS: ${err.message}`);
        setSmsReady(true);
      },
    );
    const unsubWa = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/whatsappMessages`),
        orderBy("createdAt", "asc"),
      ),
      (snap) => {
        setWa(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc));
        setWaReady(true);
      },
      (err) => {
        console.error("[conversation-thread] whatsapp subscription failed", err);
        setLoadError((prev) => prev ?? `WhatsApp: ${err.message}`);
        setWaReady(true);
      },
    );
    const unsubMeta = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/metaMessages`),
        orderBy("createdAt", "asc"),
      ),
      (snap) => {
        setMeta(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MetaMessageDoc),
        );
        setMetaReady(true);
      },
      (err) => {
        console.error("[conversation-thread] meta subscription failed", err);
        setLoadError((prev) => prev ?? `Meta: ${err.message}`);
        setMetaReady(true);
      },
    );
    // Voice calls live in a per-sub-account collection (not a per-contact
    // subcollection like the chat channels), so we read the whole thing —
    // same pattern the Voice operator console uses — and filter to this
    // contact client-side. Volume is modest (a sub-account's total call
    // count), and this sidesteps needing a composite index just for a
    // thread view.
    const unsubCalls = subscribeToVoiceCalls(
      subAccountId,
      (all) => {
        setCalls(all.filter((c) => c.contactId === contactId));
        setCallsReady(true);
      },
      (err) => {
        console.error("[conversation-thread] voice calls subscription failed", err);
        setLoadError((prev) => prev ?? `Voice: ${err.message}`);
        setCallsReady(true);
      },
    );
    return () => {
      unsubSms();
      unsubWa();
      unsubMeta();
      unsubCalls();
    };
  }, [contactId, subAccountId]);

  const merged = useMemo<TimelineEntry[]>(() => {
    const all: TimelineEntry[] = [
      ...sms.map((m) => ({ ...m, channel: "sms" as const })),
      ...wa.map((m) => ({ ...m, channel: "whatsapp" as const })),
      ...meta.map((m) => ({
        ...m,
        channel: (m.channel ?? "messenger") as ConversationChannel,
      })),
      ...calls.map((c) => ({ ...c, kind: "voice" as const })),
    ];
    all.sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
    return all;
  }, [sms, wa, meta, calls]);

  const hydrated = smsReady && waReady && metaReady && callsReady;

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [merged.length]);

  return (
    <div
      ref={scrollerRef}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4"
    >
      {!hydrated ? (
        <div className="space-y-2">
          <div className="h-12 w-2/3 animate-pulse rounded-lg bg-muted" />
          <div className="ml-auto h-12 w-3/4 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : loadError ? (
        <div className="flex h-full min-h-[150px] items-center justify-center text-center">
          <p className="max-w-sm text-xs text-destructive">
            Couldn&apos;t load this thread: {loadError}
          </p>
        </div>
      ) : merged.length === 0 ? (
        <div className="flex h-full min-h-[150px] items-center justify-center text-center">
          <p className="text-xs text-muted-foreground">
            No messages yet. Reply below to start the conversation.
          </p>
        </div>
      ) : (
        merged.map((m) =>
          m.kind === "voice" ? (
            <VoiceCallCard key={`voice:${m.id}`} call={m} saPath={saPath} />
          ) : (
            <ChannelBubble
              key={`${m.channel}:${m.id}`}
              message={m}
              theme={theme}
              contactId={contactId}
            />
          ),
        )
      )}
    </div>
  );
}

/** A voice-agent call, rendered as a centered system-style card rather than
 *  a left/right chat bubble — it's a call event, not authored text. */
function VoiceCallCard({
  call,
  saPath,
}: {
  call: VoiceEntry;
  saPath: (path: string) => string;
}) {
  const ts = toDate(call.createdAt);
  const isOutbound = call.direction === "outbound";
  const mins = Math.floor(call.durationSec / 60);
  const secs = call.durationSec % 60;
  const durationLabel =
    call.durationSec > 0 ? `${mins}:${String(secs).padStart(2, "0")}` : null;

  return (
    <div className="flex justify-center py-1">
      <Link
        href={saPath(`/ai-agents/voice/calls/${call.id}`)}
        className="flex max-w-[85%] items-start gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs transition-colors hover:bg-muted"
      >
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {isOutbound ? (
            <PhoneOutgoing className="h-3.5 w-3.5" />
          ) : call.durationSec > 0 ? (
            <PhoneIncoming className="h-3.5 w-3.5" />
          ) : (
            <Phone className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="min-w-0">
          <span className="font-medium text-foreground">
            {isOutbound ? "Outbound call" : "Voice call"}
            {durationLabel ? ` · ${durationLabel}` : " · no answer"}
          </span>
          {call.summary && (
            <span className="mt-0.5 block truncate text-muted-foreground">
              {call.summary}
            </span>
          )}
          <span className="mt-0.5 block text-[10px] text-muted-foreground/80">
            {ts
              ? ts.toLocaleString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                  month: "short",
                  day: "numeric",
                })
              : ""}
            {" · View transcript"}
          </span>
        </span>
      </Link>
    </div>
  );
}

/** Bubble color classes per (theme, channel, direction). */
function bubbleClasses(
  channel: ConversationChannel,
  isOutbound: boolean,
  theme: ConversationTheme,
): string {
  if (theme === "native") {
    if (channel === "whatsapp") {
      return isOutbound
        ? "rounded-br-sm bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-white"
        : "rounded-bl-sm bg-white text-[#111b21] ring-1 ring-black/5 dark:bg-[#202c33] dark:text-[#e9edef] dark:ring-0";
    }
    if (channel === "messenger") {
      // Messenger → blue outbound bubble
      return isOutbound
        ? "rounded-br-sm bg-[#0084ff] text-white"
        : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    if (channel === "instagram") {
      // Instagram → purple/gradient outbound bubble
      return isOutbound
        ? "rounded-br-sm bg-gradient-to-br from-[#a033ff] via-[#ff5280] to-[#ff7061] text-white"
        : "rounded-bl-sm bg-[#efefef] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    // SMS → iMessage palette
    return isOutbound
      ? "rounded-br-sm bg-[#007aff] text-white"
      : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
  }
  // Standard / brand
  return isOutbound
    ? "rounded-br-sm bg-primary text-primary-foreground"
    : "rounded-bl-sm bg-muted";
}

function ChannelBubble({
  message,
  theme,
  contactId,
}: {
  message: ChannelMessage;
  theme: ConversationTheme;
  contactId: string;
}) {
  const isOutbound = message.direction === "outbound";
  const ts = toDate(message.createdAt);
  const native = theme === "native";
  const channelLabel = CHANNEL_LABEL[message.channel] ?? message.channel;
  // Native: color conveys the channel, so drop the text chip; WhatsApp outbound
  // gets the recognizable double-tick (cosmetic "delivered" cue).
  const showTicks =
    native && isOutbound && message.channel === "whatsapp" &&
    message.status !== "failed";
  const mediaUrls = message.mediaUrls;
  const mediaContentTypes = message.mediaContentTypes;

  return (
    <div className={cn("flex flex-col", isOutbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[78%] overflow-hidden rounded-2xl px-3 py-2 text-sm",
          bubbleClasses(message.channel, isOutbound, theme),
          message.status === "failed" && "ring-2 ring-destructive",
        )}
      >
        {mediaUrls && mediaUrls.length > 0 && (
          <div className="mb-1 flex flex-col gap-1.5">
            {mediaUrls.map((_, i) => {
              // Never render the raw Twilio URL directly — it requires
              // Basic Auth the browser can't send. This proxy route
              // re-reads the URL server-side and streams the bytes.
              const src = `/api/comms/media/${contactId}/${message.id}?i=${i}`;
              const type = mediaContentTypes?.[i] ?? "";
              if (type.startsWith("video/")) {
                return (
                  <video
                    key={i}
                    src={src}
                    controls
                    className="max-h-64 w-auto rounded-lg"
                  />
                );
              }
              if (type.startsWith("audio/")) {
                return <audio key={i} src={src} controls className="w-full" />;
              }
              if (type && !type.startsWith("image/")) {
                // Unrecognized attachment type (vCard, PDF, etc) — a plain
                // download link rather than a broken <img>.
                return (
                  <a
                    key={i}
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    Download attachment
                  </a>
                );
              }
              return (
                <img
                  key={i}
                  src={src}
                  alt="Attachment"
                  className="max-h-64 w-auto rounded-lg object-contain"
                  loading="lazy"
                />
              );
            })}
          </div>
        )}
        {message.body && (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {!native && (
          <span
            className={cn(
              "rounded-full px-1.5 font-medium",
              CHANNEL_CHIP[message.channel] ?? CHANNEL_CHIP.sms,
            )}
          >
            {channelLabel}
          </span>
        )}
        <span>
          {ts
            ? ts.toLocaleString(undefined, {
                hour: "numeric",
                minute: "2-digit",
                month: "short",
                day: "numeric",
              })
            : ""}
        </span>
        {showTicks && (
          <CheckCheck
            className="h-3 w-3 text-sky-500"
            aria-label="delivered"
          />
        )}
        {message.status === "failed" && (
          <span className="text-destructive">· failed</span>
        )}
      </div>
    </div>
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
