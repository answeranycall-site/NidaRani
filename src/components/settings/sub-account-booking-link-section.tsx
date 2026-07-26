"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CalendarClock, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Single-field settings panel for `subAccount.bookingLink` — the URL
 * surfaced everywhere via the {{bookingLink}} merge tag (send_sms,
 * send_email, notify_owner_sms, broadcasts, WhatsApp templates, and the
 * Retell voice-agent follow-up templates). Can point at this sub-account's
 * own native Booking Page (/b/[id]/[slug]) or a third-party scheduler
 * (Calendly, Cal.com, TidyCal) — it's just a plain URL, nothing enforces
 * which.
 *
 * PATCHes the existing /api/agency/sub-accounts/[id] route (already
 * supports bookingLink server-side; this was the missing UI for it).
 */
export function SubAccountBookingLinkSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setUrl(subAccount?.bookingLink ?? "");
  }, [subAccount?.bookingLink]);

  if (!isAdmin) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingLink: url.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      toast.success("Booking link saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
          <CalendarClock className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Booking link</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The link you want texts/emails to point people to when booking a
            meeting — your own{" "}
            <a
              href={`/sa/${subAccountId}/booking`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Booking Page
            </a>{" "}
            (once published), or a third-party scheduler like Calendly / Cal.com
            / a Zoom or Google Meet personal room. Available anywhere as the{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              {"{{bookingLink}}"}
            </code>{" "}
            merge tag — Workflow steps, broadcasts, and the Retell voice
            follow-up templates below.
          </p>
        </div>
      </header>

      <form onSubmit={handleSave} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="booking-link-url">URL</Label>
          <Input
            id="booking-link-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://app.answeranycall.com/b/your-sub-account/your-slug"
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}
