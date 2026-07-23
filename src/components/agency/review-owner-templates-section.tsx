"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { MessageSquareText, Save } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { getFirebaseDb } from "@/lib/firebase/client";
import {
  DEFAULT_OWNER_REQUEST_SENT_TEMPLATE,
  DEFAULT_OWNER_REMINDER_TIMEOUT_TEMPLATE,
  DEFAULT_OWNER_REMINDER_SENT_TEMPLATE,
} from "@/lib/reviews/constants";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgencyDoc } from "@/types";

/**
 * Agency-wide copy for the three SMS texts a SUB-ACCOUNT'S OWN business
 * owner (accountContact.phone) receives from the review-rating-gate
 * Workflow Builder nodes. One set of copy applies across every sub-account
 * — the customer-facing templates a client's contacts see (ask/confirm/
 * internal-feedback/link message) stay per-sub-account at Settings →
 * Messaging → Review requests, since those vary by client brand voice.
 */
export function ReviewOwnerTemplatesSection() {
  const { agencyId } = useAuth();
  const [requestSent, setRequestSent] = useState("");
  const [reminderTimeout, setReminderTimeout] = useState("");
  const [reminderSent, setReminderSent] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!agencyId) return;
    const ref = doc(getFirebaseDb(), `agencies/${agencyId}`);
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data() as Partial<AgencyDoc> | undefined;
      const t = data?.reviewOwnerNotifyTemplates;
      setRequestSent(t?.requestSent || "");
      setReminderTimeout(t?.reminderTimeout || "");
      setReminderSent(t?.reminderSent || "");
      setHydrated(true);
    });
    return () => unsub();
  }, [agencyId]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/agency", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewOwnerNotifyTemplates: {
            requestSent: requestSent.trim(),
            reminderTimeout: reminderTimeout.trim(),
            reminderSent: reminderSent.trim(),
          },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save.");
      toast.success("Owner-notification templates saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <MessageSquareText className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">
            Review requests — owner notifications
          </h2>
          <p className="text-xs text-muted-foreground">
            The texts a sub-account&apos;s own business owner gets from the
            &ldquo;Ask for a rating&rdquo; / &ldquo;Remind if no reply&rdquo;
            workflow nodes. Applies across every sub-account. Tags:{" "}
            <code>{"{{clientName}}"}</code>, <code>{"{{clientPhone}}"}</code>,{" "}
            <code>{"{{businessName}}"}</code>.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rot-request-sent">Request-sent message</Label>
        <Textarea
          id="rot-request-sent"
          value={requestSent}
          onChange={(e) => setRequestSent(e.target.value)}
          placeholder={DEFAULT_OWNER_REQUEST_SENT_TEMPLATE}
          rows={2}
          className="resize-none text-sm"
        />
        <p className="text-[11px] text-muted-foreground">
          Sent the instant the rating ask goes out to the client.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rot-reminder-timeout">
          7-day no-response message
        </Label>
        <Textarea
          id="rot-reminder-timeout"
          value={reminderTimeout}
          onChange={(e) => setReminderTimeout(e.target.value)}
          placeholder={DEFAULT_OWNER_REMINDER_TIMEOUT_TEMPLATE}
          rows={2}
          className="resize-none text-sm"
        />
        <p className="text-[11px] text-muted-foreground">
          Sent when 7 days pass with no reply, right before the reminder
          re-sends.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rot-reminder-sent">Reminder-sent message</Label>
        <Textarea
          id="rot-reminder-sent"
          value={reminderSent}
          onChange={(e) => setReminderSent(e.target.value)}
          placeholder={DEFAULT_OWNER_REMINDER_SENT_TEMPLATE}
          rows={2}
          className="resize-none text-sm"
        />
        <p className="text-[11px] text-muted-foreground">
          Sent right after the one-time reminder goes back out to the
          client.
        </p>
      </div>

      <div className="flex justify-end">
        <Button size="sm" disabled={saving || !hydrated} onClick={handleSave}>
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
