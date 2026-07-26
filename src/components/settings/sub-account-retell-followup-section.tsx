"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PhoneCall } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import {
  DEFAULT_RETELL_DEMO_INFO_TEMPLATE,
  DEFAULT_RETELL_QUICK_HANGUP_TEMPLATE,
} from "@/lib/comms/voice/retell-followup";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Customizable text-back messages for Retell AI voice calls. Two distinct
 * paths, each its own template:
 *   - demoInfoTemplate — the agent calls its `send_demo_info` custom
 *     function mid-call, right after its scripted closing line
 *     (/api/webhooks/retell/send-demo-info).
 *   - quickHangupTemplate — fallback sent from call-ended ONLY when
 *     send_demo_info never fired for that call (caller hung up before the
 *     agent reached its closing line) — different tone since this caller
 *     never heard the pitch.
 * Only takes effect on the sub-account wired to RETELL_OWN_SUBACCOUNT_ID
 * (currently a fixed-target integration, not a general per-tenant
 * feature) — the section still renders for any sub-account since there's
 * no per-tenant Retell connection state to gate on yet.
 */
export function SubAccountRetellFollowUpSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const cfg = subAccount?.retellConfig;

  const [demoInfoTemplate, setDemoInfoTemplate] = useState(
    DEFAULT_RETELL_DEMO_INFO_TEMPLATE,
  );
  const [quickHangupTemplate, setQuickHangupTemplate] = useState(
    DEFAULT_RETELL_QUICK_HANGUP_TEMPLATE,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDemoInfoTemplate(
      cfg?.demoInfoTemplate || DEFAULT_RETELL_DEMO_INFO_TEMPLATE,
    );
    setQuickHangupTemplate(
      cfg?.quickHangupTemplate || DEFAULT_RETELL_QUICK_HANGUP_TEMPLATE,
    );
  }, [cfg?.demoInfoTemplate, cfg?.quickHangupTemplate]);

  if (!isAdmin) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/retell-followup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ demoInfoTemplate, quickHangupTemplate }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      toast.success("Retell follow-up messages saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background">
          <PhoneCall className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Retell voice follow-up</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Two texts, sent via this sub-account&apos;s dedicated Twilio
            number depending on how the call went.
          </p>
        </div>
      </header>

      <form onSubmit={handleSave} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="retell-demo-info">Demo-info message</Label>
          <Textarea
            id="retell-demo-info"
            value={demoInfoTemplate}
            onChange={(e) => setDemoInfoTemplate(e.target.value)}
            rows={3}
            className="resize-none text-sm"
          />
          <p className="text-[11px] text-muted-foreground">
            Sent mid-call, right after the agent says &ldquo;I&apos;m
            sending you a text right now with more info.&rdquo; Tags:{" "}
            <code>{"{{firstName}}"}</code>, <code>{"{{businessName}}"}</code>,{" "}
            <code>{"{{bookingLink}}"}</code> (set above).
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="retell-quick-hangup">
            Quick-hangup fallback message
          </Label>
          <Textarea
            id="retell-quick-hangup"
            value={quickHangupTemplate}
            onChange={(e) => setQuickHangupTemplate(e.target.value)}
            rows={3}
            className="resize-none text-sm"
          />
          <p className="text-[11px] text-muted-foreground">
            Sent instead, after the call ends, only when the caller hung up
            before the agent ever reached its closing line — so the
            demo-info message above never went out. Tags:{" "}
            <code>{"{{firstName}}"}</code>, <code>{"{{businessName}}"}</code>,{" "}
            <code>{"{{bookingLink}}"}</code> (set above).
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </section>
  );
}
