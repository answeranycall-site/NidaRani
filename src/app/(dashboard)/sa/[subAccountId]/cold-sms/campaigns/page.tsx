"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { Send } from "lucide-react";
import { getFirebaseDb } from "@/lib/firebase/client";
import { useSubAccount } from "@/context/sub-account-context";
import type { SmsCampaignDoc } from "@/types";

const STATUS_CHIP: Record<SmsCampaignDoc["status"], string> = {
  queued: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  sending: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  cancelled: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-700 dark:text-red-400",
};

export default function ColdSmsCampaignsPage() {
  const { subAccountId, saPath } = useSubAccount();
  const [campaigns, setCampaigns] = useState<SmsCampaignDoc[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      query(
        collection(getFirebaseDb(), "smsCampaigns"),
        where("subAccountId", "==", subAccountId),
        orderBy("createdAt", "desc"),
      ),
      (snap) => {
        setCampaigns(snap.docs.map((d) => d.data() as SmsCampaignDoc));
        setLoaded(true);
      },
      () => setLoaded(true),
    );
    return () => unsub();
  }, [subAccountId]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cold SMS Campaigns</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every bulk send, live status.{" "}
          <Link href={saPath("/cold-sms")} className="underline-offset-2 hover:underline">
            Back to Cold SMS
          </Link>
        </p>
      </div>

      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl border bg-card p-12 text-center">
          <Send className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-base font-semibold">No campaigns yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Launch one from the Cold SMS page.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Code</th>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Sent</th>
                <th className="px-4 py-2.5 text-right font-medium">Queued</th>
                <th className="px-4 py-2.5 text-right font-medium">Skipped / Failed</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <Link
                      href={saPath(`/cold-sms/campaigns/${c.id}`)}
                      className="font-mono text-xs font-medium underline-offset-2 hover:underline"
                    >
                      {c.code}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{c.name || "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[c.status]}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{c.totals.sent}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{c.totals.queued}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {c.totals.skipped} / {c.totals.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
