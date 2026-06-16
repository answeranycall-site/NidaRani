"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Globe,
  KeyRound,
  Loader2,
  Mail,
  MessageCircle,
  MessagesSquare,
  PhoneOutgoing,
  Send,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SubAccountDoc } from "@/types";

/**
 * Agency-side per-sub-account management dialog. Hosts the agency-only
 * feature gates — controls the sub-account admin can't flip for themselves.
 * Opened from the agency sub-accounts list.
 *
 * Current gates:
 *   - Dedicated email sending domain (Resend slot per sub-account)
 *   - Public API access (REST + webhooks for /api/v1/*)
 *   - Broadcasts / Outbound AI calling / WhatsApp
 *   - Facebook + Instagram inbox (beta) — master switch, off by default
 *
 * Only visible to the agency owner (the list page gates rendering).
 * Disabling the email gate tears down the verified Resend domain; the API
 * gate keeps keys + subscriptions intact (so re-enabling resumes them
 * without re-rotating Zapier integrations). The dialog surfaces a warning
 * for the email tear-down only.
 */

interface Props {
  subAccount: SubAccountDoc | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SubAccountManageDialog({ subAccount, open, onOpenChange }: Props) {
  const initialEmail = subAccount?.emailDomainEnabledByAgency === true;
  const initialApi = subAccount?.apiAccessEnabledByAgency === true;
  const initialBroadcasts = subAccount?.broadcastsEnabledByAgency === true;
  const initialOutbound = subAccount?.outboundVoiceEnabledByAgency === true;
  const initialWhatsapp = subAccount?.whatsappEnabledByAgency === true;
  const initialMetaInbox = subAccount?.metaInboxEnabledByAgency === true;
  const initialWebsite = subAccount?.websiteEnabledByAgency === true;
  const hasLiveDomain = !!subAccount?.resendConfig;
  const [emailDomainEnabled, setEmailDomainEnabled] = useState(initialEmail);
  const [apiAccessEnabled, setApiAccessEnabled] = useState(initialApi);
  const [broadcastsEnabled, setBroadcastsEnabled] = useState(initialBroadcasts);
  const [outboundVoiceEnabled, setOutboundVoiceEnabled] =
    useState(initialOutbound);
  const [whatsappEnabled, setWhatsappEnabled] = useState(initialWhatsapp);
  const [metaInboxEnabled, setMetaInboxEnabled] = useState(initialMetaInbox);
  const [websiteEnabled, setWebsiteEnabled] = useState(initialWebsite);
  const [saving, setSaving] = useState(false);

  // Re-sync local state every time the dialog opens or the target sub-account
  // changes, so consecutive opens don't show stale toggle state.
  useEffect(() => {
    if (open) {
      setEmailDomainEnabled(initialEmail);
      setApiAccessEnabled(initialApi);
      setBroadcastsEnabled(initialBroadcasts);
      setOutboundVoiceEnabled(initialOutbound);
      setWhatsappEnabled(initialWhatsapp);
      setMetaInboxEnabled(initialMetaInbox);
      setWebsiteEnabled(initialWebsite);
    }
  }, [
    open,
    initialEmail,
    initialApi,
    initialBroadcasts,
    initialOutbound,
    initialWhatsapp,
    initialMetaInbox,
    initialWebsite,
    subAccount?.id,
  ]);

  if (!subAccount) return null;

  const willTearDown =
    initialEmail && !emailDomainEnabled && hasLiveDomain;
  const emailDirty = emailDomainEnabled !== initialEmail;
  const apiDirty = apiAccessEnabled !== initialApi;
  const broadcastsDirty = broadcastsEnabled !== initialBroadcasts;
  const outboundDirty = outboundVoiceEnabled !== initialOutbound;
  const whatsappDirty = whatsappEnabled !== initialWhatsapp;
  const metaInboxDirty = metaInboxEnabled !== initialMetaInbox;
  const websiteDirty = websiteEnabled !== initialWebsite;
  const dirty =
    emailDirty ||
    apiDirty ||
    broadcastsDirty ||
    outboundDirty ||
    whatsappDirty ||
    metaInboxDirty ||
    websiteDirty;

  async function handleSave() {
    if (!subAccount) return;
    setSaving(true);
    try {
      // Only send the fields the agency owner actually changed. Keeps the
      // PATCH minimal and avoids redundant tear-down attempts when nothing
      // about email changed.
      const payload: {
        emailDomainEnabled?: boolean;
        apiAccessEnabled?: boolean;
        broadcastsEnabled?: boolean;
        outboundVoiceEnabled?: boolean;
        whatsappEnabled?: boolean;
        metaInboxEnabled?: boolean;
        websiteEnabled?: boolean;
      } = {};
      if (emailDirty) payload.emailDomainEnabled = emailDomainEnabled;
      if (apiDirty) payload.apiAccessEnabled = apiAccessEnabled;
      if (broadcastsDirty) payload.broadcastsEnabled = broadcastsEnabled;
      if (outboundDirty) payload.outboundVoiceEnabled = outboundVoiceEnabled;
      if (whatsappDirty) payload.whatsappEnabled = whatsappEnabled;
      if (metaInboxDirty) payload.metaInboxEnabled = metaInboxEnabled;
      if (websiteDirty) payload.websiteEnabled = websiteEnabled;

      const res = await fetch(
        `/api/agency/sub-accounts/${subAccount.id}/feature-gates`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        clearedDomain?: boolean;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to save.");
      }
      // Build the toast message from whatever the agency owner actually
      // changed. Single message covers both toggles flipped at once.
      const parts: string[] = [];
      if (emailDirty) {
        parts.push(
          emailDomainEnabled
            ? "Email sending domain enabled."
            : data.clearedDomain
              ? "Email sending domain disabled (live domain removed, reverted to shared sender)."
              : "Email sending domain disabled.",
        );
      }
      if (apiDirty) {
        parts.push(
          apiAccessEnabled
            ? "API access enabled."
            : "API access disabled. Existing keys + webhooks preserved but inert until re-enabled.",
        );
      }
      if (broadcastsDirty) {
        parts.push(
          broadcastsEnabled
            ? "Broadcasts enabled."
            : "Broadcasts disabled. Historical broadcasts preserved; new sends blocked until re-enabled.",
        );
      }
      if (outboundDirty) {
        parts.push(
          outboundVoiceEnabled
            ? "Outbound calling enabled."
            : "Outbound calling disabled. New calls blocked until re-enabled.",
        );
      }
      if (whatsappDirty) {
        parts.push(
          whatsappEnabled
            ? "WhatsApp enabled."
            : "WhatsApp disabled. The channel goes silent; Twilio creds preserved.",
        );
      }
      if (metaInboxDirty) {
        parts.push(
          metaInboxEnabled
            ? "Facebook + Instagram inbox (beta) enabled."
            : "Facebook + Instagram inbox (beta) disabled. The channels go silent and hidden.",
        );
      }
      if (websiteDirty) {
        parts.push(
          websiteEnabled
            ? "Website builder enabled."
            : "Website builder disabled. New builds blocked; existing site preserved.",
        );
      }
      toast.success(parts.join(" "));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manage {subAccount.name}</DialogTitle>
          <DialogDescription>
            Agency-level controls for this sub-account. Sub-account admins
            can&apos;t flip these — that&apos;s the point.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <GateToggle
            checked={emailDomainEnabled}
            onChange={setEmailDomainEnabled}
            disabled={saving}
            icon={<Mail className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />}
            title="Dedicated email sending domain"
          >
            When enabled, this sub-account can register its own subdomain so its
            email sends from its own brand. Consumes one slot on your Resend plan
            (Free = 1 domain total, Pro = 10, Scale = 1,000).
          </GateToggle>

          <GateToggle
            checked={apiAccessEnabled}
            onChange={setApiAccessEnabled}
            disabled={saving}
            icon={<KeyRound className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />}
            title="Public API access"
          >
            When enabled, this sub-account can mint API keys + webhooks for
            Zapier, Make, custom landing pages, etc. Disabling immediately stops
            all <code>/api/v1/*</code> traffic from their existing keys but keeps
            the keys + subscriptions intact, so re-enabling later doesn&apos;t
            force the client to re-rotate their integrations.
          </GateToggle>

          <GateToggle
            checked={broadcastsEnabled}
            onChange={setBroadcastsEnabled}
            disabled={saving}
            icon={<Send className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
            title="Broadcasts"
          >
            When enabled, this sub-account can send bulk email broadcasts (up to
            25,000 recipients per send) to filtered audiences. Disabling locks
            the Broadcasts sidebar entry and returns 403 on new send attempts;
            historical broadcast docs and in-flight QStash messages are preserved.
          </GateToggle>

          <GateToggle
            checked={websiteEnabled}
            onChange={setWebsiteEnabled}
            disabled={saving}
            icon={<Globe className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />}
            title="Website"
          >
            When enabled, this sub-account can build and publish a marketing
            site through the website builder (gitpage.site). Builds draw on your
            agency&apos;s shared gitpage quota (30 builds/hour across all
            sub-accounts). Disabling locks the Website sidebar entry and returns
            403 on new build attempts; the existing config and any published
            site are preserved, so re-enabling resumes instantly.
          </GateToggle>

          <GateToggle
            checked={outboundVoiceEnabled}
            onChange={setOutboundVoiceEnabled}
            disabled={saving}
            icon={<PhoneOutgoing className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />}
            title="Outbound AI calling"
          >
            When enabled, this sub-account can place outbound AI voice calls to
            contacts (&quot;Call with AI&quot;). Reuses the same Vapi number as
            inbound voice. Consumes call minutes and carries compliance weight —
            a built-in gate enforces opt-out, calling hours, and rate limits, but
            you control whether the feature is available at all. Disabling blocks
            new calls; no resources are torn down.
          </GateToggle>

          <GateToggle
            checked={whatsappEnabled}
            onChange={setWhatsappEnabled}
            disabled={saving}
            icon={<MessageCircle className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />}
            title="WhatsApp"
          >
            When enabled, this sub-account can turn on the WhatsApp AI channel
            (inbound auto-replies via their Twilio WhatsApp sender). Reuses the
            same Twilio credentials as SMS. Disabling silences the channel and
            makes the inbound webhook ignore this sub-account; no credentials are
            torn down, so re-enabling resumes instantly.
          </GateToggle>

          <GateToggle
            checked={metaInboxEnabled}
            onChange={setMetaInboxEnabled}
            disabled={saving}
            icon={<MessagesSquare className="h-3.5 w-3.5 text-pink-600 dark:text-pink-400" />}
            title="Facebook + Instagram inbox (beta)"
          >
            When enabled, this sub-account can connect a Facebook Page +
            Instagram business account so Messenger and IG DMs land in the
            unified inbox alongside SMS/WhatsApp. <strong>Beta</strong> — both
            channels ride one Meta connection and stay completely hidden until
            you switch this on; off is the default for every sub-account.
            Disabling silences and hides the channels; nothing is torn down, so
            re-enabling resumes instantly. Leave off for any client that doesn&apos;t
            actively use Facebook/Instagram messaging.
          </GateToggle>
        </div>

        {willTearDown && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This will remove the live sending domain{" "}
              <code className="rounded bg-amber-500/10 px-1">
                {subAccount.resendConfig?.domainName}
              </code>{" "}
              from Resend and revert this sub-account to the shared sender. In-flight
              broadcasts and automations will fall back automatically.
            </span>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GateToggle({
  checked,
  onChange,
  disabled,
  icon,
  title,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors",
        checked ? "border-primary/40 bg-primary/5" : "hover:bg-muted/40",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 cursor-pointer"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{children}</p>
      </div>
    </label>
  );
}
