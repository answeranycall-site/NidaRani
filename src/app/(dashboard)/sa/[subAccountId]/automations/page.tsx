"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import {
  Settings as SettingsIcon,
  FileText,
  History,
  Pause,
  Play,
  Sparkles,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import type { AutomationDoc } from "@/types";

export default function AutomationsHomePage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccount, subAccountId, agencyId, isAdmin, saPath } =
    useSubAccount();
  const [automations, setAutomations] = useState<AutomationDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingPause, setTogglingPause] = useState(false);
  const automationsPaused = subAccount?.automationsPaused === true;

  async function togglePause() {
    if (!isAdmin || togglingPause) return;
    const next = !automationsPaused;
    if (
      next &&
      !confirm(
        "Pause every automation in this sub-account? In-flight executions stop at their next step; new triggers (form submits, etc.) won't fire until you resume.",
      )
    ) {
      return;
    }
    setTogglingPause(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationsPaused: next }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not toggle.");
      toast.success(next ? "Automations paused." : "Automations resumed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not toggle.");
    } finally {
      setTogglingPause(false);
    }
  }

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    const q = query(
      collection(getFirebaseDb(), "automations"),
      where("subAccountId", "==", subAccountId),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setAutomations(snap.docs.map((d) => d.data() as AutomationDoc));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [user, agencyId, subAccountId, authLoading]);

  const enabledCount = automations.filter((a) => a.enabled).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Automations</h1>
          <p className="text-sm text-muted-foreground">
            Pre-built workflow recipes — fire SMS and email on triggers, no
            wiring required.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <>
              <Button
                variant={automationsPaused ? "default" : "outline"}
                size="sm"
                onClick={togglePause}
                disabled={togglingPause}
                className={
                  automationsPaused
                    ? "bg-amber-500 text-white hover:bg-amber-600"
                    : ""
                }
              >
                {automationsPaused ? (
                  <>
                    <Play className="mr-1 h-3.5 w-3.5" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="mr-1 h-3.5 w-3.5" />
                    Pause all
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                render={<Link href={saPath("/automations/activity")} />}
              >
                <History className="mr-1 h-3.5 w-3.5" />
                Activity
              </Button>
              <Button
                variant="outline"
                size="sm"
                render={<Link href={saPath("/automations/templates")} />}
              >
                <FileText className="mr-1 h-3.5 w-3.5" />
                Templates
              </Button>
              <Button
                variant="outline"
                size="sm"
                render={<Link href={saPath("/automations/settings")} />}
              >
                <SettingsIcon className="mr-1 h-3.5 w-3.5" />
                Settings
              </Button>
            </>
          )}
        </div>
      </div>

      {automationsPaused && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <Pause className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <p className="font-medium">Automations paused</p>
            <p className="text-muted-foreground">
              New triggers won&apos;t fire and in-flight executions short-circuit
              at their next step. Click <strong>Resume</strong> to bring the
              engine back online.
            </p>
          </div>
        </div>
      )}

      <section className="rounded-2xl border bg-card p-5">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Zap className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Active automations</h2>
            <p className="text-xs text-muted-foreground">
              {loading
                ? "Loading…"
                : automations.length === 0
                  ? "None yet — attach one from a form's edit page."
                  : `${enabledCount} of ${automations.length} enabled`}
            </p>
          </div>
        </div>

        {!loading && automations.length === 0 && (
          <EmptyState />
        )}

        {!loading && automations.length > 0 && (
          <ul className="space-y-2">
            {automations.map((a) => {
              const formId =
                a.trigger.type === "form_submit"
                  ? a.trigger.formId
                  : undefined;
              const rowClass =
                "flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5" +
                (formId ? " transition-colors hover:bg-muted/50" : "");
              const inner = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {recipeLabel(a.recipeType)} ·{" "}
                      {triggerLabel(a.trigger)}
                    </p>
                  </div>
                  <span
                    className={
                      a.enabled
                        ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                        : "rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                    }
                  >
                    {a.enabled ? "Enabled" : "Paused"}
                  </span>
                </>
              );
              return (
                <li key={a.id}>
                  {formId ? (
                    <Link
                      href={saPath(`/forms/${formId}`)}
                      className={rowClass}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className={rowClass}>{inner}</div>
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

function recipeLabel(t: AutomationDoc["recipeType"]): string {
  switch (t) {
    case "instant_response":
      return "Speed-to-Lead";
    default:
      return t;
  }
}

function triggerLabel(trigger: AutomationDoc["trigger"]): string {
  switch (trigger.type) {
    case "form_submit":
      return trigger.formId
        ? `Form submit · ${trigger.formId.slice(0, 8)}…`
        : "Form submit";
    default:
      return trigger.type;
  }
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed bg-gradient-to-br from-indigo-500/5 via-violet-500/5 to-pink-500/5 p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-pink-500 text-white">
        <Sparkles className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold">
        Get a reply out within 30 seconds
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Attach the <strong>Speed-to-Lead</strong> recipe to a form.
        Every submission triggers an SMS to the lead, an optional email, and
        an optional notification to your team — automatically.
      </p>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Step 1 — create a template. Step 2 — open a form&apos;s edit page and
        attach the recipe.
      </p>
    </div>
  );
}
