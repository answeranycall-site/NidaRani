"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarClock, Clock, Mail, Save } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimezoneSelect } from "@/components/ui/timezone-select";

const URL_RE = /^https?:\/\/.+/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HOURS = Array.from({ length: 25 }, (_, i) => i);

export default function AutomationsSettingsPage() {
  const { loading: authLoading } = useAuth();
  const { subAccount, subAccountId, isAdmin, saPath, loading: subLoading } =
    useSubAccount();

  const [startHour, setStartHour] = useState<number>(8);
  const [endHour, setEndHour] = useState<number>(20);
  const [timezone, setTimezone] = useState<string>("");
  const [bookingLink, setBookingLink] = useState<string>("");
  const [replyToEmail, setReplyToEmail] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!subAccount) return;
    const w = subAccount.sendWindow;
    setStartHour(w?.startHour ?? 8);
    setEndHour(w?.endHour ?? 20);
    setTimezone(
      w?.timezone ??
        subAccount.timezone ??
        (typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : "UTC"),
    );
    setBookingLink(subAccount.bookingLink ?? "");
    setReplyToEmail(subAccount.replyToEmail ?? "");
  }, [subAccount]);

  if (authLoading || subLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="h-7 w-48 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Only sub-account admins can change automation settings.
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

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!timezone.trim()) {
      toast.error("Timezone is required.");
      return;
    }
    if (startHour >= endHour) {
      toast.error("Start hour must be before end hour.");
      return;
    }
    const trimmedBooking = bookingLink.trim();
    if (trimmedBooking && !URL_RE.test(trimmedBooking)) {
      toast.error("Booking link must start with http:// or https://.");
      return;
    }
    const trimmedReplyTo = replyToEmail.trim();
    if (trimmedReplyTo && !EMAIL_RE.test(trimmedReplyTo)) {
      toast.error("Reply-to email must be a valid email address.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sendWindow: {
            startHour,
            endHour,
            timezone: timezone.trim(),
          },
          bookingLink: trimmedBooking || null,
          replyToEmail: trimmedReplyTo || null,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(payload.error ?? "Could not save settings.");
      }
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link
          href={saPath("/automations")}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to automations
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          Automation settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Send-window and per-sub-account preferences.
        </p>
      </div>

      <form
        onSubmit={handleSave}
        className="space-y-5 rounded-2xl border bg-card p-5"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Clock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Send window</h2>
            <p className="text-xs text-muted-foreground">
              Steps scheduled outside this window are deferred to the next
              window start.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="start-hour">Start hour (24h)</Label>
            <select
              id="start-hour"
              value={startHour}
              onChange={(e) => setStartHour(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {HOURS.slice(0, 24).map((h) => (
                <option key={h} value={h}>
                  {h.toString().padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="end-hour">End hour (24h)</Label>
            <select
              id="end-hour"
              value={endHour}
              onChange={(e) => setEndHour(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {HOURS.slice(1).map((h) => (
                <option key={h} value={h}>
                  {h.toString().padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="timezone">Timezone</Label>
          <TimezoneSelect
            id="timezone"
            value={timezone}
            onChange={setTimezone}
          />
          <p className="text-[11px] text-muted-foreground">
            Defaults to the sub-account&apos;s timezone.
          </p>
        </div>

        <div className="border-t pt-5" />

        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <Mail className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Reply-to email</h2>
            <p className="text-xs text-muted-foreground">
              Single source of truth for the Reply-To header on every email
              this sub-account sends — automations and manual contact-profile
              sends. Replies land here regardless of which teammate triggered
              the send.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reply-to-email">Email</Label>
          <Input
            id="reply-to-email"
            type="email"
            value={replyToEmail}
            onChange={(e) => setReplyToEmail(e.target.value)}
            placeholder="hello@bettyscookies.com"
          />
          <p className="text-[11px] text-muted-foreground">
            Leave blank to fall back to the deployment&apos;s default —
            manual sends use the teammate&apos;s email, automation sends
            ship without a Reply-To.
          </p>
        </div>

        <div className="border-t pt-5" />

        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <CalendarClock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Booking link</h2>
            <p className="text-xs text-muted-foreground">
              Drop your Calendly / Cal.com / TidyCal URL here. Insert it
              into any email or SMS template with{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                {"{{bookingLink}}"}
              </code>
              .
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="booking-link">URL</Label>
          <Input
            id="booking-link"
            type="url"
            value={bookingLink}
            onChange={(e) => setBookingLink(e.target.value)}
            placeholder="https://calendly.com/your-handle/15min"
          />
          <p className="text-[11px] text-muted-foreground">
            One URL per sub-account. Leave blank to disable —{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
              {"{{bookingLink}}"}
            </code>{" "}
            then resolves to empty string at send time.
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            <Save className="mr-1 h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
