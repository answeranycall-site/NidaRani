"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bot, CheckCircle2, Circle, Loader2, PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSubAccount } from "@/context/sub-account-context";

/**
 * Retell AI agent management — entirely separate from this codebase's own
 * Vapi-based Voice/Outbound-Voice product feature (that one's sold to
 * Answer Any Call's SaaS clients; this page is for the operator's OWN
 * cold-outreach numbers). Lists agents pulled live from Retell, and lets
 * the operator attach a published agent to any enabled Cold SMS pool
 * number so inbound calls to that number are answered by Retell.
 *
 * Outbound-via-Retell is intentionally not built yet — placeholder only.
 */

interface RetellAgent {
  agentId: string;
  name: string;
  llmId: string | null;
  prompt: string | null;
  published: boolean | null;
}

interface PoolNumberOption {
  id: string;
  e164: string;
  label: string;
  retellAgentId: string | null;
}

interface AgentsResponse {
  configured: boolean;
  error?: string;
  agents: RetellAgent[];
  numbers: PoolNumberOption[];
}

const BIND_STEPS = [
  "Publish the agent's current version in Retell",
  "Import the number into Retell over the SIP trunk (or update it, if already imported)",
  "Bind the agent as that number's inbound handler",
  "Record the binding on the number in this CRM",
];

export default function RetellVoicePage() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [data, setData] = useState<AgentsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/retell/agents`);
      const json = (await res.json()) as AgentsResponse;
      setData(json);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Retell agents");
    } finally {
      setLoaded(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    if (subAccount && subAccount.raniMastermindEnabledByAgency !== true) {
      setLoaded(true);
      return;
    }
    void load();
  }, [isAdmin, load, subAccount]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          Admin access required to manage Retell voice agents.
        </p>
      </div>
    );
  }

  if (subAccount && subAccount.raniMastermindEnabledByAgency !== true) {
    return (
      <div className="p-6">
        <div className="rounded-2xl border bg-card p-12 text-center">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-base font-semibold">Locked by your agency</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            The Retell Voice Agent integration isn&apos;t enabled for this
            sub-account. Ask your agency owner to turn on RANI MASTERMIND
            from Manage.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Retell Voice Agent</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Your Retell agents, live from your Retell account. Attach a
          published agent to any Cold SMS pool number to have Retell answer
          inbound calls to it. Separate from the Vapi Voice channel under AI
          Agents — that&apos;s the product feature sold to your clients;
          this is your own numbers.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What &ldquo;Attach&rdquo; does, every time
        </p>
        <ol className="mt-2 space-y-1.5 text-sm">
          {BIND_STEPS.map((step, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded-xl border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Outbound via Retell</span> —
        not built yet. This page is inbound-only for now.
      </div>

      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data?.configured ? (
        <div className="rounded-2xl border bg-card p-12 text-center">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-base font-semibold">Retell isn&apos;t configured</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Set <code className="rounded bg-muted px-1 py-0.5">RETELL_API_KEY</code>,{" "}
            <code className="rounded bg-muted px-1 py-0.5">RETELL_SIP_TERMINATION_URI</code>,
            and optionally{" "}
            <code className="rounded bg-muted px-1 py-0.5">RETELL_SIP_TRUNK_USERNAME</code> /{" "}
            <code className="rounded bg-muted px-1 py-0.5">RETELL_SIP_TRUNK_PASSWORD</code> on
            this deployment.
          </p>
        </div>
      ) : data.error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          {data.error}
        </p>
      ) : data.agents.length === 0 ? (
        <div className="rounded-2xl border bg-card p-12 text-center">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-base font-semibold">No Retell agents found</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one in your Retell dashboard, then refresh this page.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.agents.map((agent) => (
            <AgentCard
              key={agent.agentId}
              agent={agent}
              numbers={data.numbers}
              subAccountId={subAccountId}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  numbers,
  subAccountId,
  onChanged,
}: {
  agent: RetellAgent;
  numbers: PoolNumberOption[];
  subAccountId: string;
  onChanged: () => void;
}) {
  const assignedNumbers = numbers.filter((n) => n.retellAgentId === agent.agentId);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);

  async function attach() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/numbers/${selected}/assign-retell-agent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: agent.agentId }),
        },
      );
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed to attach");
      toast.success("Agent attached — inbound calls to that number now route to Retell.");
      setSelected("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to attach");
    } finally {
      setBusy(false);
    }
  }

  async function detach(numberId: string) {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/numbers/${numberId}/assign-retell-agent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: null }),
        },
      );
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed to detach");
      toast.success("Detached.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to detach");
    } finally {
      setBusy(false);
    }
  }

  const availableNumbers = numbers.filter((n) => !n.retellAgentId);

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{agent.name}</h3>
              {agent.published === true && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Published
                </span>
              )}
              {agent.published === false && (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <Circle className="h-3 w-3" />
                  Not published
                </span>
              )}
            </div>
            {agent.prompt && (
              <p className="mt-1 line-clamp-2 max-w-xl text-xs text-muted-foreground">
                {agent.prompt}
              </p>
            )}
          </div>
        </div>
      </div>

      {assignedNumbers.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {assignedNumbers.map((n) => (
            <div
              key={n.id}
              className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-1.5 text-xs"
            >
              <span className="flex items-center gap-1.5">
                <PhoneCall className="h-3 w-3" />
                {n.label} ({n.e164})
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => detach(n.id)}
                className="h-6 px-2 text-xs"
              >
                Detach
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
        >
          <option value="">Attach to a Cold SMS number…</option>
          {availableNumbers.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} ({n.e164})
            </option>
          ))}
        </select>
        <Button size="sm" disabled={!selected || busy} onClick={attach}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Attach"}
        </Button>
      </div>
    </div>
  );
}
