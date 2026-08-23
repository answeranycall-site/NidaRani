"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getFirebaseDb } from "@/lib/firebase/client";
import { useSubAccount } from "@/context/sub-account-context";
import type { SmsCampaignDoc, SmsCampaignRecipientDoc } from "@/types";

export default function ColdSmsCampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = use(params);
  const { saPath } = useSubAccount();
  const [campaign, setCampaign] = useState<SmsCampaignDoc | null>(null);
  const [recipients, setRecipients] = useState<SmsCampaignRecipientDoc[]>([]);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(getFirebaseDb(), "smsCampaigns", campaignId), (snap) => {
      setCampaign(snap.exists() ? (snap.data() as SmsCampaignDoc) : null);
    });
    return () => unsub();
  }, [campaignId]);

  useEffect(() => {
    const unsub = onSnapshot(
      query(
        collection(getFirebaseDb(), "smsCampaigns", campaignId, "recipients"),
        orderBy("queuedAt", "desc"),
        limit(150),
      ),
      (snap) => setRecipients(snap.docs.map((d) => d.data() as SmsCampaignRecipientDoc)),
    );
    return () => unsub();
  }, [campaignId]);

  async function cancel() {
    if (!window.confirm("Stop this campaign? Everything still queued will be skipped.")) return;
    setCancelling(true);
    try {
      const res = await fetch("/api/comms/sms/campaign/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed to cancel");
      toast.success("Campaign cancelled.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setCancelling(false);
    }
  }

  if (!campaign) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const active = campaign.status === "queued" || campaign.status === "sending";

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.code}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {campaign.name || "Unnamed campaign"} ·{" "}
            <Link href={saPath("/cold-sms/campaigns")} className="underline-offset-2 hover:underline">
              All campaigns
            </Link>
          </p>
        </div>
        {active && (
          <Button variant="destructive" size="sm" disabled={cancelling} onClick={cancel}>
            {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
            Stop campaign
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-5">
        <Tile label="Status" value={campaign.status} />
        <Tile label="Audience" value={String(campaign.totals.audienceSize)} />
        <Tile label="Sent" value={String(campaign.totals.sent)} />
        <Tile label="Queued" value={String(campaign.totals.queued)} />
        <Tile label="Skipped / Failed" value={`${campaign.totals.skipped} / ${campaign.totals.failed}`} />
      </div>

      {campaign.rebalancedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {campaign.rebalancedCount} recipient(s) were rotation-balanced onto a
          different number at launch.
          {campaign.numbersBoughtAtLaunch > 0 &&
            ` ${campaign.numbersBoughtAtLaunch} number(s) were purchased to close a sizing gap.`}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Contact</th>
              <th className="px-4 py-2.5 font-medium">From number</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {recipients.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium">{r.toName || "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.toPhone}</div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{r.fromNumber || "—"}</td>
                <td className="px-4 py-3">
                  <span
                    className={
                      "inline-flex rounded-full px-2 py-0.5 text-xs font-medium " +
                      (r.status === "sent"
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : r.status === "failed"
                          ? "bg-red-500/10 text-red-700 dark:text-red-400"
                          : r.status === "skipped"
                            ? "bg-muted text-muted-foreground"
                            : "bg-amber-500/10 text-amber-700 dark:text-amber-400")
                    }
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {r.skippedReason || r.error || ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Showing the most recent 150 recipients.
      </p>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold capitalize">{value}</div>
    </div>
  );
}
