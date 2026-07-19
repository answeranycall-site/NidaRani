"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  Building2,
  CheckCircle2,
  Globe,
  Image as ImageIcon,
  Loader2,
  Phone,
  Save,
  Sparkles,
  Star,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DEFAULT_REVIEW_SMS_TEMPLATE } from "@/lib/reviews/constants";

/**
 * Client Onboarding — one page that consolidates the fields that used to be
 * scattered across Settings → Admin, Branding, Google Reviews, AI Agents →
 * Overview, and Settings → SMS. Each field still saves through its EXISTING
 * real route (no new backend model beyond logoUrl auto-fetch + the new
 * caseStudyOptIn flag) — this page is a friendlier front door onto them, not
 * a replacement data model.
 *
 * The dedicated Twilio number is deliberately READ-ONLY here — assigning one
 * is an agency-side action (picking from owned inventory or buying new),
 * not something an operator self-serves from a form field. Settings → SMS
 * is still where that actually gets configured.
 */

const CHECKLIST_ITEMS = [
  "Website",
  "Missed Call Text-Back",
  "Dead Lead Reactivation",
  "Google Review Automation",
  "Website Chat-to-SMS",
  "Local SEO Visibility (Optional)",
];

interface ProfileState {
  websiteUrl: string;
}

export function ClientOnboardingForm() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();

  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [reviewUrl, setReviewUrl] = useState("");
  const [caseStudyOptIn, setCaseStudyOptIn] = useState(false);

  const [hydrated, setHydrated] = useState(false);
  const [fetchingLogo, setFetchingLogo] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate once from the live sub-account doc + a one-time profile fetch
  // (the AI agent profile isn't part of the SubAccountDoc snapshot).
  useEffect(() => {
    if (hydrated || !subAccount || !subAccountId) return;
    setBusinessName(subAccount.name ?? "");
    setOwnerName(subAccount.accountContact?.name ?? "");
    setOwnerEmail(subAccount.accountContact?.email ?? "");
    setOwnerPhone(subAccount.accountContact?.phone ?? "");
    setLogoUrl(subAccount.logoUrl ?? "");
    setReviewUrl(subAccount.googleReviewConfig?.reviewUrl ?? "");
    setCaseStudyOptIn(subAccount.caseStudyOptIn === true);

    fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`)
      .then((r) => r.json())
      .then((data: { profile?: ProfileState | null }) => {
        setWebsiteUrl(data.profile?.websiteUrl ?? "");
      })
      .catch(() => {})
      .finally(() => setHydrated(true));
  }, [hydrated, subAccount, subAccountId]);

  if (!isAdmin) return null;

  async function handleFetchLogo() {
    if (!websiteUrl.trim()) {
      toast.error("Enter a website URL first.");
      return;
    }
    setFetchingLogo(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/branding/fetch-logo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ websiteUrl }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        logoUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.logoUrl) {
        throw new Error(data.error ?? "Couldn't find a logo on that site.");
      }
      setLogoUrl(data.logoUrl);
      toast.success("Logo found — review it below, then Save.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't fetch a logo.");
    } finally {
      setFetchingLogo(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const jobs: Promise<Response>[] = [];

      // Business name + account contact + case-study opt-in.
      jobs.push(
        fetch(`/api/agency/sub-accounts/${subAccountId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: businessName,
            accountContact: {
              name: ownerName,
              email: ownerEmail,
              phone: ownerPhone,
            },
            caseStudyOptIn,
          }),
        }),
      );

      // Logo.
      jobs.push(
        fetch(`/api/sub-accounts/${subAccountId}/branding`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ logoUrl: logoUrl || null }),
        }),
      );

      // Website URL (AI agent profile).
      jobs.push(
        fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ websiteUrl: websiteUrl || null }),
        }),
      );

      // Google review URL — preserve any existing review config (channel,
      // rating gate, custom templates) rather than resetting it to bare
      // defaults; only a fresh (never-configured) sub-account turns the
      // feature on here.
      if (reviewUrl.trim()) {
        const existing = subAccount?.googleReviewConfig;
        jobs.push(
          fetch(`/api/sub-accounts/${subAccountId}/google-review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              existing
                ? { ...existing, reviewUrl: reviewUrl.trim() }
                : {
                    reviewUrl: reviewUrl.trim(),
                    channel: "sms",
                    enabled: true,
                    messageTemplate: DEFAULT_REVIEW_SMS_TEMPLATE,
                  },
            ),
          }),
        );
      }

      const results = await Promise.all(jobs);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast.error(`Saved, but ${failed.length} field group(s) failed.`);
      } else {
        toast.success("Onboarding info saved.");
      }
    } catch {
      toast.error("Couldn't save — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const twilioNumber = subAccount?.twilioConfig?.enabled
    ? subAccount.twilioConfig.fromNumber
    : null;

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="space-y-6">
        <section className="rounded-2xl border bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Building2 className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Business</h2>
              <p className="text-xs text-muted-foreground">
                Shown throughout the CRM and in message templates.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ob-business-name">Business name</Label>
              <Input
                id="ob-business-name"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="Simple Willow Properties"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-website">Website URL</Label>
              <Input
                id="ob-website"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://example.com"
              />
            </div>
          </div>
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
              <Phone className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Owner contact</h2>
              <p className="text-xs text-muted-foreground">
                The business owner — this phone number is also where the{" "}
                <strong>&ldquo;Text the owner&rdquo;</strong> workflow node
                and Missed Call Text-Back&apos;s owner heads-up send to.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ob-owner-name">Owner name</Label>
              <Input
                id="ob-owner-name"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-owner-email">Owner email</Label>
              <Input
                id="ob-owner-email"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-owner-phone">
                Owner phone{" "}
                <span className="font-normal text-muted-foreground">
                  (text-me number)
                </span>
              </Label>
              <Input
                id="ob-owner-phone"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
                placeholder="+15551234567"
              />
            </div>
          </div>
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400">
              <ImageIcon className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Logo</h2>
              <p className="text-xs text-muted-foreground">
                Renders on quotes/invoices and the public quote page.
              </p>
            </div>
          </div>
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="ob-logo">Logo URL</Label>
              <Input
                id="ob-logo"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://example.com/logo.png"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleFetchLogo}
              disabled={fetchingLogo}
            >
              {fetchingLogo ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              Fetch from website
            </Button>
          </div>
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt="Logo preview"
              className="mt-3 h-12 w-auto rounded border bg-white object-contain p-1"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          )}
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Star className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Google review page</h2>
              <p className="text-xs text-muted-foreground">
                Feeds the <code>{"{{reviewLink}}"}</code>-style text used by
                the &ldquo;Job Completed – Review Request&rdquo; workflow.{" "}
                <strong className="text-destructive">
                  That workflow&apos;s SMS won&apos;t resolve correctly until
                  this is filled in.
                </strong>
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-review">Google review URL</Label>
            <Input
              id="ob-review"
              value={reviewUrl}
              onChange={(e) => setReviewUrl(e.target.value)}
              placeholder="https://g.page/r/…/review"
            />
          </div>
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
              <Globe className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Dedicated Twilio number</h2>
              <p className="text-xs text-muted-foreground">
                Read-only — assigning a number is done by the agency (Settings
                → SMS), not from this form.
              </p>
            </div>
          </div>
          <p className="text-sm">
            {twilioNumber ? (
              <span className="font-medium">{twilioNumber}</span>
            ) : (
              <span className="text-muted-foreground">
                Not configured yet.
              </span>
            )}
          </p>
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <div className="flex items-start gap-3">
            <Checkbox
              id="ob-case-study"
              checked={caseStudyOptIn}
              onCheckedChange={(v) => setCaseStudyOptIn(!!v)}
            />
            <div>
              <Label htmlFor="ob-case-study" className="text-sm font-medium">
                Opt in to being featured as a case study / portfolio piece
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Optional — lets the agency showcase results from this account
                in marketing.
              </p>
            </div>
          </div>
        </section>

        <Button type="submit" disabled={saving}>
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-3.5 w-3.5" />
          )}
          Save onboarding info
        </Button>
      </form>

      <section className="rounded-2xl border bg-card p-5">
        <h2 className="mb-1 text-sm font-semibold">What We&apos;re Installing</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          A visual overview for the client — not a live status indicator yet.
        </p>
        <ul className="space-y-2.5">
          {CHECKLIST_ITEMS.map((item) => (
            <li key={item} className="flex items-center gap-2.5 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
