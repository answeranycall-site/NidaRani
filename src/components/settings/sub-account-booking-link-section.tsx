"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CalendarClock, CreditCard, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Two-field settings panel for `subAccount.bookingLink` + `paymentLink` —
 * the URLs surfaced everywhere via the {{bookingLink}} / {{paymentLink}}
 * merge tags (send_sms, send_email, notify_owner_sms, broadcasts, WhatsApp
 * templates, and the Retell voice-agent follow-up templates). Kept as two
 * separate fields (not one generic "link") since a business often wants to
 * send BOTH — "book a call" and "pay / sign up" — independently.
 *
 * bookingLink can point at this sub-account's own native Booking Page
 * (/b/[id]/[slug]) or a third-party scheduler (Calendly, Cal.com, TidyCal).
 * paymentLink is typically a Stripe Payment Link (set up directly in the
 * operator's own Stripe account — this deployment's own Stripe wiring is
 * reserved for LeadStack-template billing, not for buyers to charge their
 * own clients) or a PayPal.me link. Both are just plain URLs, nothing
 * enforces which tool.
 *
 * PATCHes the existing /api/agency/sub-accounts/[id] route (already
 * supports both fields server-side; this was the missing UI for them).
 */
export function SubAccountBookingLinkSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [bookingUrl, setBookingUrl] = useState("");
  const [paymentUrl, setPaymentUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBookingUrl(subAccount?.bookingLink ?? "");
    setPaymentUrl(subAccount?.paymentLink ?? "");
  }, [subAccount?.bookingLink, subAccount?.paymentLink]);

  if (!isAdmin) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingLink: bookingUrl.trim() || null,
          paymentLink: paymentUrl.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      toast.success("Links saved.");
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
          <h2 className="text-base font-semibold">Quick links</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Reusable URLs available in every send_sms / send_email / notify
            step, broadcast, and the Retell follow-up templates below — set
            once here, reference everywhere via merge tags.
          </p>
        </div>
      </header>

      <form onSubmit={handleSave} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="booking-link-url">Booking link</Label>
          <Input
            id="booking-link-url"
            type="url"
            value={bookingUrl}
            onChange={(e) => setBookingUrl(e.target.value)}
            placeholder="https://app.answeranycall.com/b/your-sub-account/your-slug"
          />
          <p className="text-[11px] text-muted-foreground">
            Your own{" "}
            <a
              href={`/sa/${subAccountId}/booking`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Booking Page
            </a>{" "}
            (once published), or a third-party scheduler like Calendly / Cal.com.
            Available as{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              {"{{bookingLink}}"}
            </code>
            .
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="payment-link-url" className="flex items-center gap-1.5">
            <CreditCard className="h-3.5 w-3.5" />
            Payment link
          </Label>
          <Input
            id="payment-link-url"
            type="url"
            value={paymentUrl}
            onChange={(e) => setPaymentUrl(e.target.value)}
            placeholder="https://buy.stripe.com/xxxxxxxx"
          />
          <p className="text-[11px] text-muted-foreground">
            A Stripe Payment Link (Stripe Dashboard → Payment Links — supports
            recurring subscriptions, permanent URL, set up in your own Stripe
            account) or PayPal.me link. Available as{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              {"{{paymentLink}}"}
            </code>
            .
          </p>
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
