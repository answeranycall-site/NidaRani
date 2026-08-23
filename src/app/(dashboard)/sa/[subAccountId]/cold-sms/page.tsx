"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  Headset,
  Loader2,
  PhoneOutgoing,
  RefreshCw,
  Star,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSubAccount } from "@/context/sub-account-context";
import { ColdSmsImportDialog } from "@/components/cold-sms/cold-sms-import-dialog";
import { SmsCampaignDialog } from "@/components/cold-sms/sms-campaign-dialog";
import type { TwilioPoolNumber } from "@/types";

/**
 * Cold SMS number-pool management. Numbers are added either one at a time
 * (rare) or, more commonly, in bulk via "Sync from Twilio" — which pulls
 * every number the sub-account's Twilio account already owns and adopts
 * any not yet tracked. Stats + enable/disable live here; the pool-wide
 * on/off + default rate stay on Settings → SMS (this page manages
 * individual numbers, not whether pooling is turned on at all).
 */

type PoolNumber = TwilioPoolNumber & {
  last24hSent: number;
  last24hErrors: number;
  /** null = couldn't check live (Twilio lookup failed / not configured),
   *  distinct from false (checked, and it's wrong). */
  smsHookOk: boolean | null;
  voiceHookOk: boolean | null;
  currentVoiceUrl: string | null;
};

interface NumbersResponse {
  numberPoolEnabled: boolean;
  defaultRatePerMinutePerNumber: number;
  hookCheckError: string | null;
  numbers: PoolNumber[];
}

export default function ColdSmsPage() {
  const { subAccountId, subAccount, isAdmin, saPath } = useSubAccount();

  const [data, setData] = useState<NumbersResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addNumber, setAddNumber] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/twilio/numbers`);
      const json = (await res.json()) as NumbersResponse;
      if (!res.ok) throw new Error("Failed to load numbers");
      setData(json);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load numbers");
    } finally {
      setLoaded(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    // Optimistic while the gate is still loading (subAccount === null) —
    // same philosophy as the sidebar's lock-badge rendering. Once loaded,
    // an explicit false skips the fetch entirely (the API 403s anyway, but
    // no point firing it + showing an error toast on a locked page).
    if (subAccount && subAccount.raniMastermindEnabledByAgency !== true) {
      setLoaded(true);
      return;
    }
    void load();
  }, [isAdmin, load, subAccount]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/numbers/sync`,
        { method: "POST" },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        added?: number;
        alreadyTracked?: number;
        webhookFailures?: number;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Sync failed");
      toast.success(
        `Synced from Twilio — ${json.added} new, ${json.alreadyTracked} already tracked.` +
          (json.webhookFailures ? ` ${json.webhookFailures} webhook config failures.` : ""),
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleAdd() {
    const e164 = addNumber.trim();
    if (!e164) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/twilio/numbers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ e164, label: addLabel.trim() || undefined }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed to add number");
      toast.success("Number added.");
      setAddLabel("");
      setAddNumber("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add number");
    } finally {
      setAdding(false);
    }
  }

  const allNumbers = useMemo(() => data?.numbers ?? [], [data]);
  const numbers = useMemo(
    () => allNumbers.filter((n) => !n.archivedAt),
    [allNumbers],
  );
  const archivedNumbers = useMemo(
    () => allNumbers.filter((n) => !!n.archivedAt),
    [allNumbers],
  );
  const summary = useMemo(() => {
    const enabled = numbers.filter((n) => n.enabled).length;
    const autoDisabled = numbers.filter((n) => n.autoDisabledAt).length;
    const sent24h = numbers.reduce((s, n) => s + n.last24hSent, 0);
    const errors24h = numbers.reduce((s, n) => s + n.last24hErrors, 0);
    const successRate24h =
      sent24h > 0 ? (((sent24h - errors24h) / sent24h) * 100).toFixed(1) : null;
    return { enabled, autoDisabled, sent24h, successRate24h };
  }, [numbers]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          Admin access required to manage the Cold SMS number pool.
        </p>
      </div>
    );
  }

  if (subAccount && subAccount.raniMastermindEnabledByAgency !== true) {
    return (
      <div className="p-6">
        <div className="rounded-2xl border bg-card p-12 text-center">
          <PhoneOutgoing className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-base font-semibold">Locked by your agency</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Cold SMS isn&apos;t enabled for this sub-account. Ask your agency
            owner to turn on RANI MASTERMIND from Manage.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cold SMS</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The Twilio number pool that powers cold outreach — each contact
            permanently sticks to whichever number first reaches them, and
            every number is paced independently so none of them get flagged.
            Pool-wide on/off + default pace live in{" "}
            <Link
              href={saPath("/dashboard/settings")}
              className="underline-offset-2 hover:underline"
            >
              Settings → SMS
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setCampaignOpen(true)} variant="default">
            New campaign
          </Button>
          <Link
            href={saPath("/cold-sms/campaigns")}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            Campaigns
          </Link>
          <Button onClick={() => setImportOpen(true)} variant="outline">
            <Upload className="h-3.5 w-3.5" />
            Import contacts
          </Button>
          <Button onClick={handleSync} disabled={syncing} variant="outline">
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync from Twilio
          </Button>
        </div>
      </div>

      {loaded && data?.hookCheckError && (
        <p className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Couldn&apos;t verify hook status live: {data.hookCheckError} — the
          Hooks column below is showing &ldquo;unknown&rdquo; until this
          resolves.
        </p>
      )}

      {loaded && data && (
        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryTile label="Numbers" value={String(numbers.length)} />
          <SummaryTile label="Enabled" value={String(summary.enabled)} />
          <SummaryTile
            label="Auto-disabled"
            value={String(summary.autoDisabled)}
            warn={summary.autoDisabled > 0}
          />
          <SummaryTile
            label="Last 24h success"
            value={
              summary.successRate24h !== null
                ? `${summary.successRate24h}% (${summary.sent24h} sent)`
                : "No sends yet"
            }
          />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Add a number manually (E.164)
          </label>
          <Input
            value={addNumber}
            onChange={(e) => setAddNumber(e.target.value)}
            placeholder="+15551234567"
            className="w-48 font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Label (optional)
          </label>
          <Input
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
            placeholder="Line 13"
            className="w-40"
          />
        </div>
        <Button onClick={handleAdd} disabled={adding || !addNumber.trim()} size="sm">
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
        </Button>
      </div>

      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : numbers.length === 0 ? (
        <div className="rounded-2xl border bg-card p-12 text-center">
          <PhoneOutgoing className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-base font-semibold">No numbers in the pool yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Click &ldquo;Sync from Twilio&rdquo; to pull in your existing
            numbers, or add one manually above.
          </p>
        </div>
      ) : (
        <NumbersTable numbers={numbers} subAccountId={subAccountId} onChanged={load} />
      )}

      {archivedNumbers.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Archive className="h-3.5 w-3.5" />
            {showArchived ? "Hide" : "Show"} archived numbers ({archivedNumbers.length})
          </button>
          {showArchived && (
            <NumbersTable
              numbers={archivedNumbers}
              subAccountId={subAccountId}
              onChanged={load}
              archived
            />
          )}
        </div>
      )}

      <ColdSmsImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={load}
      />
      <SmsCampaignDialog open={campaignOpen} onOpenChange={setCampaignOpen} />
    </div>
  );
}

function NumbersTable({
  numbers,
  subAccountId,
  onChanged,
  archived,
}: {
  numbers: PoolNumber[];
  subAccountId: string;
  onChanged: () => void;
  archived?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">Number</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Hooks</th>
            <th className="px-4 py-2.5 text-right font-medium">Lifetime sent / errors</th>
            <th className="px-4 py-2.5 text-right font-medium">Last 24h sent / errors</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {numbers.map((n) => (
            <NumberRow
              key={n.id}
              number={n}
              subAccountId={subAccountId}
              onChanged={onChanged}
              archived={archived}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Twilio's typical billing cycle is ~30 days from provisioning. */
function renewalLabel(purchasedAt: unknown): string | null {
  const ts = purchasedAt as { toDate?: () => Date } | null | undefined;
  const date = ts?.toDate?.();
  if (!date) return null;
  const daysSince = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  const daysUntilRenewal = 30 - (daysSince % 30);
  const purchasedLabel = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `Purchased ${purchasedLabel} — renews in ~${daysUntilRenewal}d`;
}

function SummaryTile({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={
          "mt-1 text-lg font-semibold " +
          (warn ? "text-amber-600 dark:text-amber-500" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}

function NumberRow({
  number,
  subAccountId,
  onChanged,
  archived,
}: {
  number: PoolNumber;
  subAccountId: string;
  onChanged: () => void;
  archived?: boolean;
}) {
  const { saPath } = useSubAccount();
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [fixing, setFixing] = useState(false);

  const lifetimeErrorPct =
    number.lifetimeSent > 0
      ? ((number.lifetimeErrors / number.lifetimeSent) * 100).toFixed(1)
      : "0.0";
  const renewal = renewalLabel(number.purchasedAt);
  const hooksNeedFix = number.smsHookOk === false || number.voiceHookOk === false;

  async function fixHooks() {
    setFixing(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/numbers/${number.id}/fix-hooks`,
        { method: "POST" },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        smsError?: string | null;
        voiceError?: string | null;
      };
      if (!res.ok) throw new Error(json.error ?? "Failed to fix hooks");
      toast.success("Hooks re-pointed at this CRM.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fix hooks");
    } finally {
      setFixing(false);
    }
  }

  async function toggleEnabled() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/numbers/${number.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !number.enabled }),
        },
      );
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed to update");
      toast.success(number.enabled ? "Number disabled." : "Number re-enabled.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  async function requestDeletion() {
    const confirmed = window.confirm(
      `Release ${number.label} (${number.e164}) from Twilio? This stops the recurring charge but is irreversible — Twilio cannot un-release a number back to you.`,
    );
    if (!confirmed) return;
    setReleasing(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/numbers/${number.id}/release`,
        { method: "POST" },
      );
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed to release");
      toast.success("Number released from Twilio and archived.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to release");
    } finally {
      setReleasing(false);
    }
  }

  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 font-medium">
          {number.isPrimary && (
            <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
          )}
          {number.label}
        </div>
        <div className="font-mono text-xs text-muted-foreground">{number.e164}</div>
        {renewal && (
          <div className="mt-0.5 text-[11px] text-muted-foreground/70">{renewal}</div>
        )}
      </td>
      <td className="px-4 py-3">
        {archived ? (
          <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Released from Twilio
          </span>
        ) : number.autoDisabledAt ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
            <AlertTriangle className="h-3 w-3" />
            Auto-flagged
          </span>
        ) : number.enabled ? (
          <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Enabled
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Disabled
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {archived ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col gap-1 text-[11px]">
            <HookBadge label="SMS" ok={number.smsHookOk} />
            {number.retellAgentId ? (
              <Link
                href={saPath("/retell-voice")}
                className="inline-flex w-fit items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 font-medium text-violet-700 hover:underline dark:text-violet-400"
              >
                <Headset className="h-3 w-3" />
                Retell agent
              </Link>
            ) : (
              <HookBadge label="Voice" ok={number.voiceHookOk} />
            )}
            {hooksNeedFix && (
              <Button
                size="sm"
                variant="ghost"
                disabled={fixing}
                onClick={fixHooks}
                className="h-6 w-fit px-1.5 text-[11px]"
              >
                {fixing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Wrench className="h-3 w-3" />
                )}
                Fix
              </Button>
            )}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
        <span className="font-medium">{number.lifetimeSent}</span>
        <span className="text-muted-foreground"> / {number.lifetimeErrors}</span>
        <span className="ml-1 text-[11px] text-muted-foreground">({lifetimeErrorPct}%)</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
        <span className="font-medium">{number.last24hSent}</span>
        <span className="text-muted-foreground"> / {number.last24hErrors}</span>
      </td>
      <td className="px-4 py-3 text-right">
        {archived ? (
          <span className="text-xs text-muted-foreground">No actions</span>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={toggleEnabled}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : number.enabled ? (
                "Disable"
              ) : (
                "Enable"
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={releasing}
              onClick={requestDeletion}
              title="Request deletion from Twilio"
              className="text-red-600 hover:text-red-700 dark:text-red-400"
            >
              {releasing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function HookBadge({ label, ok }: { label: string; ok: boolean | null }) {
  if (ok === null) {
    return (
      <span className="inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
        {label}: unknown
      </span>
    );
  }
  return (
    <span
      className={
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 font-medium " +
        (ok
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-red-500/10 text-red-700 dark:text-red-400")
      }
    >
      {label}: {ok ? "OK" : "not us"}
    </span>
  );
}
