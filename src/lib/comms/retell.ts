import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { cleanEnv } from "@/lib/env";

/**
 * Retell AI integration for the operator's OWN inbound-voice numbers —
 * entirely separate from the Vapi-based Voice/Outbound-Voice AI Agent
 * feature this codebase already ships as a product to Answer Any Call's
 * own SaaS clients. Different provider, different purpose (the operator's
 * personal cold-outreach number pool, not a client-facing feature). Never
 * conflate the two in code or UI.
 *
 * Endpoint confidence: create-retell-llm, create-agent, update-agent,
 * import-phone-number, and publish-agent-version are all VERIFIED against
 * the operator's own working Apps Script. list-agents, get-retell-llm, and
 * list-phone-numbers below are reasonable inferences from Retell's
 * consistent naming convention, NOT independently verified — spot-check
 * these against a real Retell account before relying on them, and expect
 * to adjust field names if Retell's actual response shape differs.
 */

const RETELL_BASE = "https://api.retellai.com";

export function retellIsConfigured(): boolean {
  return !!cleanEnv(process.env.RETELL_API_KEY);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${cleanEnv(process.env.RETELL_API_KEY)}`,
    "Content-Type": "application/json",
  };
}

export interface RetellAgentSummary {
  agentId: string;
  name: string;
  llmId: string | null;
  prompt: string | null;
  /** Retell's `is_published` / last-publish state, when the list response
   *  exposes it — null when we couldn't determine it. */
  published: boolean | null;
}

/** GET /list-agents — INFERRED endpoint, verify against a real account. */
export async function listRetellAgents(): Promise<
  { ok: true; agents: RetellAgentSummary[] } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`${RETELL_BASE}/list-agents`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      return { ok: false, error: `Retell returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as Array<{
      agent_id: string;
      agent_name?: string;
      response_engine?: { type?: string; llm_id?: string };
      is_published?: boolean;
    }>;
    const summaries = await Promise.all(
      data.map(async (a) => {
        const llmId = a.response_engine?.llm_id ?? null;
        const prompt = llmId ? await getRetellLlmPrompt(llmId) : null;
        return {
          agentId: a.agent_id,
          name: a.agent_name || a.agent_id,
          llmId,
          prompt,
          published: typeof a.is_published === "boolean" ? a.is_published : null,
        };
      }),
    );
    return { ok: true, agents: summaries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Request failed" };
  }
}

/** GET /get-retell-llm/{id} — INFERRED endpoint. Best-effort: returns null
 *  (not an error) on failure so one bad LLM lookup doesn't break the whole
 *  agent list. */
async function getRetellLlmPrompt(llmId: string): Promise<string | null> {
  try {
    const res = await fetch(`${RETELL_BASE}/get-retell-llm/${llmId}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { general_prompt?: string };
    return data.general_prompt ?? null;
  } catch {
    return null;
  }
}

/** GET /list-phone-numbers — INFERRED endpoint, verify against a real
 *  account. Used only to decide import-vs-update when attaching. */
async function listRetellPhoneNumbers(): Promise<
  Array<{ phone_number: string; inbound_agent_id?: string | null }>
> {
  try {
    const res = await fetch(`${RETELL_BASE}/list-phone-numbers`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    return (await res.json()) as Array<{
      phone_number: string;
      inbound_agent_id?: string | null;
    }>;
  } catch {
    return [];
  }
}

export interface AttachResult {
  ok: boolean;
  error: string | null;
  steps?: { step: string; ok: boolean; detail?: string }[];
}

/**
 * The 4-step bind sequence: publish the agent -> import the number into
 * Retell (or update it, if already imported) -> confirm the bind ->
 * record it on our own `twilioNumbers/{numberId}` doc. Every step is
 * reported individually so the caller can show exactly what happened,
 * per the operator's request to always see the steps.
 */
export async function attachRetellAgentToNumber(input: {
  subAccountId: string;
  numberId: string;
  e164: string;
  agentId: string;
}): Promise<AttachResult> {
  if (!retellIsConfigured()) {
    return { ok: false, error: "RETELL_API_KEY is not set on this deployment." };
  }
  const terminationUri = cleanEnv(process.env.RETELL_SIP_TERMINATION_URI);
  const sipUsername = cleanEnv(process.env.RETELL_SIP_TRUNK_USERNAME);
  const sipPassword = cleanEnv(process.env.RETELL_SIP_TRUNK_PASSWORD);
  if (!terminationUri) {
    return {
      ok: false,
      error:
        "RETELL_SIP_TERMINATION_URI is not set — copy it from your Retell dashboard's SIP trunk settings.",
    };
  }

  const steps: { step: string; ok: boolean; detail?: string }[] = [];

  // Step 1 — publish, so the number always binds to the current version.
  try {
    const res = await fetch(`${RETELL_BASE}/publish-agent-version/${input.agentId}`, {
      method: "POST",
      headers: authHeaders(),
    });
    steps.push({ step: "Publish agent", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` });
  } catch (err) {
    steps.push({
      step: "Publish agent",
      ok: false,
      detail: err instanceof Error ? err.message : "Request failed",
    });
    return { ok: false, error: "Failed to publish the agent — see steps.", steps };
  }

  // Step 2 — import (first-time) or update (already imported) the number.
  const existing = await listRetellPhoneNumbers();
  const alreadyImported = existing.find((p) => p.phone_number === input.e164);
  try {
    if (alreadyImported) {
      const res = await fetch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(input.e164)}`,
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ inbound_agent_id: input.agentId }),
        },
      );
      steps.push({
        step: "Bind agent to number (already imported)",
        ok: res.ok,
        detail: res.ok ? undefined : `HTTP ${res.status}`,
      });
      if (!res.ok) return { ok: false, error: "Failed to bind agent — see steps.", steps };
    } else {
      const res = await fetch(`${RETELL_BASE}/import-phone-number`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          phone_number: input.e164,
          termination_uri: terminationUri,
          sip_trunk_auth_username: sipUsername || undefined,
          sip_trunk_auth_password: sipPassword || undefined,
          inbound_agents: [{ agent_id: input.agentId, weight: 1.0 }],
          nickname: input.e164,
        }),
      });
      steps.push({
        step: "Import number into Retell",
        ok: res.ok,
        detail: res.ok ? undefined : `HTTP ${res.status}`,
      });
      if (!res.ok) return { ok: false, error: "Failed to import the number — see steps.", steps };
    }
  } catch (err) {
    steps.push({
      step: "Bind agent to number",
      ok: false,
      detail: err instanceof Error ? err.message : "Request failed",
    });
    return { ok: false, error: "Failed to bind agent — see steps.", steps };
  }

  // Step 3 — record the binding on our own side.
  try {
    await getAdminDb()
      .doc(`subAccounts/${input.subAccountId}/twilioNumbers/${input.numberId}`)
      .set({ retellAgentId: input.agentId }, { merge: true });
    steps.push({ step: "Record binding in CRM", ok: true });
  } catch (err) {
    steps.push({
      step: "Record binding in CRM",
      ok: false,
      detail: err instanceof Error ? err.message : "Write failed",
    });
    return { ok: false, error: "Bound in Retell but failed to save locally — see steps.", steps };
  }

  return { ok: true, error: null, steps };
}

/** Unassign — clears our record and best-effort clears Retell's binding
 *  too (sets inbound_agent_id to null). The Twilio side is untouched. */
export async function detachRetellAgentFromNumber(input: {
  subAccountId: string;
  numberId: string;
  e164: string;
}): Promise<AttachResult> {
  if (retellIsConfigured()) {
    try {
      await fetch(`${RETELL_BASE}/update-phone-number/${encodeURIComponent(input.e164)}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ inbound_agent_id: null }),
      });
    } catch {
      // Best-effort — the local unassign below still proceeds either way.
    }
  }
  try {
    await getAdminDb()
      .doc(`subAccounts/${input.subAccountId}/twilioNumbers/${input.numberId}`)
      .set({ retellAgentId: null }, { merge: true });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Write failed" };
  }
}
