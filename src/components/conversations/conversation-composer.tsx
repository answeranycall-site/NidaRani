"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { GoogleGIcon } from "@/components/brand/google-g-icon";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types/contacts";
import type { ConversationChannel } from "@/types/conversations";

const LABEL: Record<ConversationChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

/** Human copy for /api/comms/review-request/send's `reason` codes. */
const REVIEW_SEND_REASON: Record<string, string> = {
  not_configured: "Google reviews aren't configured for this sub-account yet.",
  no_phone: "This contact has no phone number.",
  opted_out: "This contact opted out of this channel.",
  sms_not_configured: "SMS isn't configured on this deployment.",
  whatsapp_gate_off: "WhatsApp is disabled for this sub-account by your agency.",
  whatsapp_not_configured: "Add a WhatsApp sender under Settings → SMS first.",
  window_closed: "The WhatsApp 24h window is closed — the customer needs to message first.",
  no_template: "Pick an approved WhatsApp template under the review settings.",
  template_not_approved: "That WhatsApp template isn't approved yet.",
  template_var_missing: "The WhatsApp template is missing a required value.",
  send_failed: "Couldn't send — check the deployment logs.",
};

/**
 * Channel-aware reply box. Posts to the EXISTING send routes
 * (/api/comms/sms/send, /api/comms/whatsapp/send) — the snapshot listener in
 * ConversationThread surfaces the new row. Defaults to the channel the contact
 * last used; the operator can switch when more than one is available.
 */
export function ConversationComposer({
  contact,
  availableChannels,
  defaultChannel,
}: {
  contact: Contact;
  availableChannels: ConversationChannel[];
  defaultChannel: ConversationChannel;
}) {
  const { subAccount } = useSubAccount();
  const initial = availableChannels.includes(defaultChannel)
    ? defaultChannel
    : (availableChannels[0] ?? "sms");
  const [channel, setChannel] = useState<ConversationChannel>(initial);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [askingForReview, setAskingForReview] = useState(false);

  // "Ask for review" — only when a review link is configured. Sends
  // directly through the same dispatcher the quote-paid/deal-completed
  // triggers use (/api/comms/review-request/send), NOT the plain SMS/
  // WhatsApp send route — that dispatcher is what decides between the
  // direct review link and the "how many stars" rating-gate ask (and, for
  // the latter, stamps the flag the inbound webhook checks to intercept
  // the 1-5 reply). Pre-filling the composer textarea for a manual send
  // bypassed all of that: it always sent the direct-link text and never
  // stamped the awaiting-reply flag, so the rating gate silently never
  // triggered no matter how the setting was configured.
  const reviewCfg = subAccount?.googleReviewConfig ?? null;
  const reviewConfigured = !!reviewCfg?.reviewUrl;

  async function handleAskForReview() {
    setAskingForReview(true);
    try {
      const res = await fetch("/api/comms/review-request/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sent?: boolean;
        reason?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't send review request.");
      }
      if (data.sent) {
        toast.success("Review request sent.");
      } else {
        toast.error(
          (data.reason && REVIEW_SEND_REASON[data.reason]) ||
            "Couldn't send the review request.",
        );
      }
      // Snapshot listener in ConversationThread appends the row.
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't send review request.",
      );
    } finally {
      setAskingForReview(false);
    }
  }

  if (availableChannels.length === 0) {
    return (
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">
        No messaging channel is configured for this sub-account. Set up a
        dedicated Twilio number (Settings → SMS) to reply here.
      </div>
    );
  }

  // Meta (Messenger / Instagram) replies post to a different route, identify
  // the recipient by `metaUserId` (not phone), and have no STOP-style opt-out.
  const isMeta = channel === "messenger" || channel === "instagram";
  const optedOut = isMeta
    ? false
    : channel === "sms"
      ? !!contact.smsOptedOut
      : !!contact.whatsappOptedOut;
  const endpoint = isMeta
    ? "/api/comms/meta/send"
    : channel === "sms"
      ? "/api/comms/sms/send"
      : "/api/comms/whatsapp/send";
  const hasIdentity = isMeta ? !!contact.metaUserId : !!contact.phone;
  const disabled = optedOut || sending || !hasIdentity;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!hasIdentity) {
      toast.error(
        isMeta
          ? "This contact hasn't messaged via Facebook/Instagram."
          : "This contact has no phone number.",
      );
      return;
    }
    if (optedOut) {
      toast.error(`This contact opted out of ${LABEL[channel]}.`);
      return;
    }
    setSending(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          body: trimmed,
          ...(isMeta ? { channel } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't send.");
      }
      setBody("");
      // Snapshot listener appends the row.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t px-4 py-3">
      {availableChannels.length > 1 && (
        <div className="mb-2 flex gap-1">
          {availableChannels.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setChannel(ch)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                channel === ch
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {LABEL[ch]}
            </button>
          ))}
        </div>
      )}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          optedOut
            ? `Contact opted out of ${LABEL[channel]}`
            : `Reply via ${LABEL[channel]} to ${
                (isMeta ? contact.name : contact.phone) || "this contact"
              }…`
        }
        rows={2}
        disabled={disabled}
        className="min-h-[60px] resize-none px-3 py-2 text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        {reviewConfigured ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleAskForReview}
            disabled={askingForReview || sending}
            title="Send a Google review request now"
          >
            {askingForReview ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <GoogleGIcon className="mr-1 h-3.5 w-3.5" />
            )}
            Ask for review
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="submit"
          size="sm"
          disabled={!body.trim() || disabled}
        >
          {sending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" />
          )}
          Send via {LABEL[channel]}
        </Button>
      </div>
    </form>
  );
}
