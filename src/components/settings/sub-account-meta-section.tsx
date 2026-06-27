"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Instagram,
  Loader2,
  MessagesSquare,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";

/**
 * Sub-account Facebook Messenger + Instagram DM settings panel (BETA).
 *
 * Gate-driven: renders NOTHING unless the caller is a sub-account admin AND the
 * agency has flipped `metaInboxEnabledByAgency` on. That's the contract — the
 * feature stays invisible in every sub-account until the agency unlocks it.
 *
 * When unlocked it shows either a "Connect" entry point (full-page redirect to
 * the OAuth start route) or the connected Page / IG handle with a Disconnect
 * button. It also surfaces the webhook callback URL + redirect URI the agency
 * needs to register in their Meta app, and reads the `?meta=…` status the
 * connect/callback routes redirect back with.
 */

const STATUS_MESSAGES: Record<
  string,
  { ok: boolean; text: string }
> = {
  connected: { ok: true, text: "Facebook + Instagram connected." },
  connected_no_sub: {
    ok: false,
    text: "Connected, but the page webhook subscription failed — try Disconnect then Connect again.",
  },
  cancelled: { ok: false, text: "Connection cancelled." },
  bad_state: { ok: false, text: "Connection failed a security check. Try again." },
  not_configured: {
    ok: false,
    text: "Facebook/Instagram isn't configured on this deployment yet (missing Meta app credentials).",
  },
  gate_off: { ok: false, text: "This feature is locked by your agency." },
  no_pages: {
    ok: false,
    text: "No Facebook Pages were available on that account.",
  },
  error: { ok: false, text: "Couldn't connect to Meta. Please try again." },
};

export function SubAccountMetaSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const gateOn = subAccount?.metaInboxEnabledByAgency === true;
  const cfg = subAccount?.metaConfig ?? null;
  const [disconnecting, setDisconnecting] = useState(false);

  // Surface the ?meta=… status the connect/callback routes redirect back with,
  // then strip it from the URL so a refresh doesn't re-toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("meta");
    if (!status) return;
    const msg = STATUS_MESSAGES[status];
    if (msg) {
      if (msg.ok) toast.success(msg.text);
      else toast.error(msg.text);
    }
    params.delete("meta");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  }, []);

  const webhookUrl = useMemo(() => {
    const base =
      typeof window !== "undefined"
        ? window.location.origin
        : (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    return `${base}/api/webhooks/meta`;
  }, []);

  const redirectUri = useMemo(() => {
    const base =
      typeof window !== "undefined"
        ? window.location.origin
        : (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    return `${base}/api/sub-accounts/${subAccountId}/meta/callback`;
  }, [subAccountId]);

  // Gate: invisible unless admin + agency-enabled.
  if (!isAdmin || !gateOn) return null;

  function handleConnect() {
    // Full-page nav so the OAuth redirect chain works.
    window.location.href = `/api/sub-accounts/${subAccountId}/meta/connect`;
  }

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect Facebook + Instagram for this sub-account? Messenger and IG DMs will stop landing in the inbox. Message history is kept; you can reconnect anytime.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/meta`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      toast.success("Facebook + Instagram disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  function copy(value: string, label: string) {
    void navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  }

  const connected = !!cfg?.connected;

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-pink-500/10 text-pink-600 dark:text-pink-400">
          <MessagesSquare className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Facebook + Instagram inbox</h2>
            <span className="rounded-full bg-pink-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-pink-600 dark:text-pink-400">
              Beta
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect a Facebook Page (and its linked Instagram business account)
            so Messenger and IG DMs land in the unified inbox alongside SMS and
            WhatsApp. One connection powers both channels.
          </p>
        </div>
      </header>

      {connected ? (
        <div className="rounded-lg border bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                {cfg?.pageName || "Facebook Page"}
              </p>
              {cfg?.instagramUsername ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Instagram className="h-3.5 w-3.5" />@{cfg.instagramUsername}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No Instagram business account linked to this Page.
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disconnecting}
              onClick={handleDisconnect}
            >
              {disconnecting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-background p-4">
          <p className="text-sm font-medium">Not connected</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Connect your Facebook Page to start receiving Messenger + Instagram
            messages here. You&apos;ll be sent to Facebook to authorise access.
          </p>
          <div className="mt-3">
            <Button type="button" size="sm" onClick={handleConnect}>
              Connect Facebook &amp; Instagram
            </Button>
          </div>
        </div>
      )}

      {/* Setup reference — the URLs the agency registers in their Meta app. */}
      <div className="mt-4 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Meta app setup (one-time)</p>
        <p className="mt-1">
          The agency registers these in the Meta app (Webhooks + Facebook Login
          → Valid OAuth redirect URIs). Beta access also requires Meta App
          Review for messaging permissions.
        </p>
        <div className="mt-2 space-y-2">
          <div>
            <p className="mb-1 text-[11px] font-medium text-foreground">
              Webhook callback URL
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-background px-2 py-1.5 text-[11px]">
                {webhookUrl}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => copy(webhookUrl, "Webhook URL")}
              >
                <Copy className="mr-1 h-3 w-3" />
                Copy
              </Button>
            </div>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-foreground">
              OAuth redirect URI
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-background px-2 py-1.5 text-[11px]">
                {redirectUri}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => copy(redirectUri, "Redirect URI")}
              >
                <Copy className="mr-1 h-3 w-3" />
                Copy
              </Button>
            </div>
          </div>
        </div>
        <p className="mt-2 flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Beta — inbound messages appear in the inbox; replying from
            Messenger/Instagram is coming in a follow-up update.
          </span>
        </p>
      </div>
    </section>
  );
}
