"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import {
  Building2,
  Image as ImageIcon,
  Loader2,
  Phone,
  Save,
  Star,
  UserPlus,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseStorage } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { DEFAULT_REVIEW_SMS_TEMPLATE } from "@/lib/reviews/constants";

/**
 * Client Onboarding — rendered on the sub-account Dashboard, consolidating
 * the fields that used to be scattered across Settings → Admin, Branding,
 * Google Reviews, AI Agents → Overview, and Settings → SMS. Each field still
 * saves through its EXISTING real route — this is a friendlier front door
 * onto them, not a replacement data model.
 *
 * The dedicated Twilio number itself is a separate, read-only display kept
 * in Settings → Admin (not here) — it's edited at Settings → Messaging → SMS.
 */

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB, matches storage.rules

/** slug -> display label, in the exact order requested. Slugs are the
 *  storage key (SubAccountDoc.onboardingChecklist) so relabeling later
 *  doesn't lose anyone's progress. */
const CHECKLIST_ITEMS: { slug: string; label: string }[] = [
  { slug: "website", label: "Website" },
  { slug: "twilioNumber", label: "New Twilio Number" },
  { slug: "missedCallAiChat", label: "Missed Call Text-Back & AI Chat" },
  { slug: "deadLeadReactivation", label: "Dead Lead Reactivation" },
  { slug: "googleReviewAutomation", label: "Google Review Automation" },
  { slug: "websiteChatToSms", label: "Website Chat-to-SMS" },
  { slug: "localSeo", label: "Local SEO Visibility (Optional)" },
];

interface ProfileState {
  websiteUrl: string;
}

function OnboardingChecklist() {
  const { subAccountId, subAccount } = useSubAccount();
  const { agencyRole } = useAuth();
  const isAgencyOwner = agencyRole === "owner";
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setChecklist(subAccount?.onboardingChecklist ?? {});
  }, [subAccount?.onboardingChecklist]);

  async function toggle(slug: string, done: boolean) {
    // Optimistic — flip immediately, roll back on failure.
    setChecklist((prev) => ({ ...prev, [slug]: done }));
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${subAccountId}/onboarding-checklist`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item: slug, done }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Couldn't save.");
      }
    } catch (err) {
      setChecklist((prev) => ({ ...prev, [slug]: !done }));
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="mb-1 text-sm font-semibold">What We&apos;re Installing</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        A visual overview for the client — not a live status indicator yet.
        {!isAgencyOwner &&
          " Only the agency owner can check items off; you can see progress here."}
      </p>
      <ul className="space-y-2.5">
        {CHECKLIST_ITEMS.map(({ slug, label }) => {
          const done = checklist[slug] === true;
          return (
            <li key={slug} className="flex items-center gap-2.5 text-sm">
              <Checkbox
                checked={done}
                disabled={!isAgencyOwner}
                onCheckedChange={(v) => toggle(slug, !!v)}
              />
              <span
                className={cn(
                  done && "text-muted-foreground line-through decoration-2",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ClientOnboardingForm() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [reviewUrl, setReviewUrl] = useState("");

  const [hydrated, setHydrated] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
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

    fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`)
      .then((r) => r.json())
      .then((data: { profile?: ProfileState | null }) => {
        setWebsiteUrl(data.profile?.websiteUrl ?? "");
      })
      .catch(() => {})
      .finally(() => setHydrated(true));
  }, [hydrated, subAccount, subAccountId]);

  if (!isAdmin) return null;

  async function handleLogoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file (JPG, PNG, WebP, or GIF).");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("Image is too large — keep it under 5 MB.");
      return;
    }
    setUploadingLogo(true);
    try {
      const ext = file.name.includes(".") ? file.name.split(".").pop() : "img";
      const path = `branding/${subAccountId}/logo-${Date.now()}.${ext}`;
      const storageRef = ref(getFirebaseStorage(), path);
      await uploadBytes(storageRef, file, { contentType: file.type });
      const url = await getDownloadURL(storageRef);
      setLogoUrl(url);
      toast.success("Logo uploaded — click Save to apply it.");
    } catch {
      toast.error("Couldn't upload that image.");
    } finally {
      setUploadingLogo(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const jobs: Promise<Response>[] = [];

      // Business name + account contact.
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

  return (
    <div className="space-y-6">
      <OnboardingChecklist />

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
          <div className="flex items-center gap-3">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt="Logo preview"
                className="h-12 w-auto rounded border bg-white object-contain p-1"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleLogoFileChange}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingLogo}
            >
              {uploadingLogo ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImageIcon className="mr-1.5 h-3.5 w-3.5" />
              )}
              {logoUrl ? "Replace logo" : "Upload logo"}
            </Button>
          </div>
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
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <UserPlus className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Add another person</h2>
              <p className="text-xs text-muted-foreground">
                Give an employee of this client their own login.
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Go to <strong className="text-foreground">Settings → Admin</strong>{" "}
            → Members section → invite by email → choose{" "}
            <strong className="text-foreground">Admin</strong> (full access)
            or <strong className="text-foreground">Collaborator</strong>{" "}
            (day-to-day access, no member management).
          </p>
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
    </div>
  );
}
