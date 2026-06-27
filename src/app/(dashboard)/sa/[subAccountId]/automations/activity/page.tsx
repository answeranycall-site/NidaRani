"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  History,
  Mail,
  MessageSquare,
  Minus,
  Pause,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  AutomationDoc,
  ExecutionDoc,
  ExecutionStepHistoryEntry,
} from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Per-sub-account automation activity log. Lists every recent execution doc
 * with its step-by-step history — what fired, who it went to, what was
 * skipped, what failed and why. Schema's already populated by the executor;
 * this is a pure read-only view.
 */
export default function AutomationsActivityPage() {
  const { loading: authLoading } = useAuth();
  const { subAccountId, isAdmin, saPath, loading: subLoading } = useSubAccount();
  const [executions, setExecutions] = useState<ExecutionDoc[]>([]);
  const [loading, setLoading] = useState(true);

  // Lookup tables built lazily as executions stream in.
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [automationNames, setAutomationNames] = useState<Record<string, string>>(
    {},
  );

  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || subLoading || !subAccountId) return;
    const q = query(
      collection(getFirebaseDb(), "automation_executions"),
      where("subAccountId", "==", subAccountId),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as ExecutionDoc);
        // Newest first. startedAt may be a Timestamp or null until the
        // server settles it; we sort by ms descending with null pushed
        // to the bottom.
        rows.sort((a, b) => millis(b.startedAt) - millis(a.startedAt));
        setExecutions(rows);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [authLoading, subLoading, subAccountId]);

  // Hydrate contact + automation display names for the rows we have. One
  // getDoc per unique id, cached on first appearance. Cheap on a 100-row
  // page; if it grows, swap to chunked `documentId() in [...]` queries.
  useEffect(() => {
    const db = getFirebaseDb();
    const contactIds = new Set(executions.map((e) => e.contactId));
    const automationIds = new Set(executions.map((e) => e.automationId));

    contactIds.forEach((id) => {
      if (contactNames[id]) return;
      void getDoc(doc(db, "contacts", id))
        .then((s) => {
          if (s.exists()) {
            const c = s.data() as Partial<Contact>;
            setContactNames((prev) => ({
              ...prev,
              [id]: c.name?.trim() || c.email?.trim() || `Contact ${id.slice(0, 6)}`,
            }));
          } else {
            setContactNames((prev) => ({ ...prev, [id]: "(deleted contact)" }));
          }
        })
        .catch(() => {
          setContactNames((prev) => ({ ...prev, [id]: `Contact ${id.slice(0, 6)}` }));
        });
    });

    automationIds.forEach((id) => {
      if (automationNames[id]) return;
      void getDoc(doc(db, "automations", id))
        .then((s) => {
          if (s.exists()) {
            const a = s.data() as Partial<AutomationDoc>;
            setAutomationNames((prev) => ({
              ...prev,
              [id]: a.name?.trim() || `Automation ${id.slice(0, 6)}`,
            }));
          } else {
            setAutomationNames((prev) => ({ ...prev, [id]: "(deleted automation)" }));
          }
        })
        .catch(() => {
          setAutomationNames((prev) => ({
            ...prev,
            [id]: `Automation ${id.slice(0, 6)}`,
          }));
        });
    });
  }, [executions, contactNames, automationNames]);

  const summary = useMemo(() => {
    return executions.reduce(
      (acc, e) => {
        acc[e.status] = (acc[e.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<ExecutionDoc["status"], number>,
    );
  }, [executions]);

  if (!isAdmin && !subLoading) {
    return (
      <div className="mx-auto max-w-4xl rounded-2xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Only sub-account admins can view automation activity.
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<Link href={saPath("/automations")} />}
          className="mt-4"
        >
          Back to automations
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link
          href={saPath("/automations")}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to automations
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          Automation activity
        </h1>
        <p className="text-sm text-muted-foreground">
          Every execution that fired in this sub-account — what was sent, what
          was skipped, what failed.
        </p>
      </div>

      <section className="rounded-2xl border bg-card p-5">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <History className="h-4 w-4" />
          </span>
          <div className="flex-1">
            <h2 className="text-sm font-semibold">Recent executions</h2>
            <p className="text-xs text-muted-foreground">
              {loading
                ? "Loading…"
                : executions.length === 0
                  ? "No executions yet — submit a form with an attached automation to see one."
                  : `${executions.length} total · ${summary.running ?? 0} running · ${summary.completed ?? 0} completed · ${summary.stopped ?? 0} stopped · ${summary.failed ?? 0} failed`}
            </p>
          </div>
        </div>

        {!loading && executions.length === 0 && (
          <div className="rounded-lg border border-dashed bg-background p-8 text-center text-sm text-muted-foreground">
            Once an automation fires, you&apos;ll see every step it took here —
            the channel, recipient, and any errors.
          </div>
        )}

        {!loading && executions.length > 0 && (
          <ul className="divide-y">
            {executions.map((e) => {
              const isOpen = expanded === e.id;
              const startedAt = toDate(e.startedAt);
              const contactName = contactNames[e.contactId] ?? "…";
              const automationName = automationNames[e.automationId] ?? "…";
              const stepsRun = e.history?.length ?? 0;
              const lastEntry = e.history?.[e.history.length - 1];
              return (
                <li key={e.id} className="py-2">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : e.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/40"
                    aria-expanded={isOpen}
                  >
                    <StatusBadge status={e.status} stoppedReason={e.stoppedReason} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {contactName}{" "}
                        <span className="font-normal text-muted-foreground">
                          · {automationName}
                        </span>
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {startedAt
                          ? startedAt.toLocaleString()
                          : "Pending"}
                        {" · "}
                        {stepsRun} step{stepsRun === 1 ? "" : "s"} run
                        {lastEntry && !lastEntry.success && (
                          <>
                            {" · "}
                            <span className="text-rose-700 dark:text-rose-400">
                              last step failed
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        isOpen && "rotate-180",
                      )}
                    />
                  </button>

                  {isOpen && (
                    <div className="mt-2 space-y-2 rounded-lg border bg-background p-3 text-xs">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <KV label="Execution ID" value={e.id} mono />
                        <KV label="Contact ID" value={e.contactId} mono />
                        <KV
                          label="Stopped reason"
                          value={e.stoppedReason ?? "—"}
                        />
                        <KV
                          label="Current step"
                          value={String(e.currentStepIndex)}
                        />
                      </div>

                      {e.history && e.history.length > 0 ? (
                        <div className="mt-3">
                          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Steps
                          </p>
                          <ol className="space-y-1.5">
                            {e.history.map((h, i) => (
                              <StepRow key={i} entry={h} />
                            ))}
                          </ol>
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          No steps have run yet.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusBadge({
  status,
  stoppedReason,
}: {
  status: ExecutionDoc["status"];
  stoppedReason: ExecutionDoc["stoppedReason"];
}) {
  if (status === "running") {
    return (
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400">
        <Minus className="h-3 w-3" />
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (status === "stopped") {
    const isPaused = stoppedReason === "automation_disabled";
    return (
      <span
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          isPaused
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
            : "bg-muted text-muted-foreground",
        )}
        title={stoppedReason ?? "stopped"}
      >
        {isPaused ? <Pause className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
      </span>
    );
  }
  // failed
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-700 dark:text-rose-400">
      <X className="h-3 w-3" />
    </span>
  );
}

function StepRow({ entry }: { entry: ExecutionStepHistoryEntry }) {
  const sentAt = toDate(entry.sentAt);
  const Icon = entry.channel === "email" ? Mail : MessageSquare;
  const tint =
    entry.success === false
      ? "border-rose-500/30 bg-rose-500/5"
      : entry.skippedReason
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-emerald-500/30 bg-emerald-500/5";
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-1.5",
        tint,
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-[11px]">
          <span className="font-medium">Step {entry.stepIndex + 1}</span>
          {" · "}
          <span className="uppercase tracking-wider text-muted-foreground">
            {entry.channel}
          </span>
          {entry.recipient && (
            <>
              {" → "}
              <span className="font-mono text-[10px]">{entry.recipient}</span>
            </>
          )}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {sentAt ? sentAt.toLocaleString() : "Pending"}
          {entry.skippedReason && (
            <>
              {" · "}
              <span className="text-amber-700 dark:text-amber-400">
                Skipped — {entry.skippedReason}
              </span>
            </>
          )}
          {entry.success === false && entry.error && (
            <>
              {" · "}
              <span className="text-rose-700 dark:text-rose-400">
                {entry.error}
              </span>
            </>
          )}
          {entry.success === true && (
            <>
              {" · "}
              <span className="text-emerald-700 dark:text-emerald-400">
                Sent
              </span>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("text-[11px]", mono && "font-mono")}>{value}</p>
    </div>
  );
}

function millis(v: unknown): number {
  if (!v) return 0;
  const maybe = v as { toMillis?: () => number; seconds?: number };
  if (typeof maybe.toMillis === "function") return maybe.toMillis();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
