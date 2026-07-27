"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Building2,
  Compass,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Phone,
  PhoneMissed,
  Save,
  Star,
  Upload,
  UserPlus,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
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
 *
 * Logo + old-leads-file are pasted links, not uploads — this deployment
 * doesn't have Firebase Storage enabled, so there's nowhere to receive an
 * uploaded file. Operators host the image/file themselves (Google Drive,
 * Dropbox, their own site) and paste the resulting link.
 */

/** slug -> display label (+ optional client-facing benefit line), in the
 *  exact order requested. Slugs are the storage key
 *  (SubAccountDoc.onboardingChecklist) so relabeling later doesn't lose
 *  anyone's progress. */
const CHECKLIST_ITEMS: { slug: string; label: string; description?: string }[] = [
  {
    slug: "website",
    label: "Website",
    description: "Builds trust the moment someone finds you",
  },
  {
    slug: "twilioNumber",
    label: "New Twilio Number",
    description: "Catches every call you'd otherwise miss",
  },
  {
    slug: "missedCallAiChat",
    label: "Missed Call Text-Back & AI Chat",
    description: "No lead ever goes unanswered, day or night",
  },
  {
    slug: "deadLeadReactivation",
    label: "Dead Lead Reactivation",
    description: "Turns old \"no's\" into new bookings",
  },
  {
    slug: "googleReviewAutomation",
    label: "Google Review Automation",
    description: "More 5-star reviews, more trust, higher rank",
  },
  {
    slug: "websiteChatToSms",
    label: "Website Chat-to-SMS",
    description: "Website visitors become real conversations",
  },
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
        {CHECKLIST_ITEMS.map(({ slug, label, description }) => {
          const done = checklist[slug] === true;
          return (
            <li key={slug} className="flex items-start gap-2.5 text-sm">
              <Checkbox
                checked={done}
                disabled={!isAgencyOwner}
                onCheckedChange={(v) => toggle(slug, !!v)}
                className="mt-0.5"
              />
              <span
                className={cn(
                  done && "text-muted-foreground line-through decoration-2",
                )}
              >
                <strong className="font-semibold">{label}</strong>
                {description && (
                  <span className="text-muted-foreground"> → {description}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Link slot for the operator's exported "old leads" list — feeds the
 *  Dead Lead Reactivation item above. Points at a file the operator hosts
 *  themselves (Google Drive, Dropbox, etc.) rather than an upload, since
 *  this deployment doesn't have Firebase Storage enabled. Purely a
 *  durable reference; nothing in the app reads or imports it
 *  automatically — use the CSV importer at /sa/[id]/import to actually
 *  load contacts from a file. */
function OldLeadsUpload() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const existing = subAccount?.oldLeadsFile ?? null;
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setUrl(existing?.url ?? "");
    setLabel(existing?.fileName ?? "");
  }, [existing?.url, existing?.fileName]);

  if (!isAdmin) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const trimmedUrl = url.trim();
      const res = await fetch(`/api/sub-accounts/${subAccountId}/old-leads-file`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          trimmedUrl
            ? { url: trimmedUrl, fileName: label.trim() || "Old leads list" }
            : { url: null },
        ),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Couldn't save.");
      }
      toast.success(trimmedUrl ? "Old leads link saved." : "Old leads link cleared.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:text-orange-400">
          <Upload className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Old leads file</h2>
          <p className="text-xs text-muted-foreground">
            For Dead Lead Reactivation above. Host your exported list
            somewhere (Google Drive shared as &ldquo;Anyone with the
            link&rdquo;, Dropbox, etc.) and paste the link here so it stays put and you
            can get back to it anytime.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="ob-old-leads-url">Link</Label>
            <Input
              id="ob-old-leads-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://drive.google.com/…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-old-leads-label">Label</Label>
            <Input
              id="ob-old-leads-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Old leads list"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          {existing?.url ? (
            <a
              href={existing.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Open current link
            </a>
          ) : (
            <span />
          )}
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Save
          </Button>
        </div>
      </form>
    </section>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Inline "invite a teammate" form — actually sends the invite here
 *  instead of just pointing at Settings → Admin → Members (still the
 *  place for the full roster / pending-invites list / removal, but
 *  adding someone shouldn't require leaving this page). Reuses the same
 *  invite endpoint the Members settings section uses. */
function AddPersonInline() {
  const { subAccountId, isAdmin } = useSubAccount();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "collaborator">("collaborator");
  const [inviting, setInviting] = useState(false);

  if (!isAdmin) return null;

  async function handleInvite() {
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      toast.error("Enter a valid email.");
      return;
    }
    setInviting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, role }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        mailed?: boolean;
      };
      if (!res.ok) throw new Error(data.error ?? "Couldn't invite.");
      toast.success(
        data.mailed
          ? `Invite emailed to ${trimmed}`
          : `Invited ${trimmed} — see Settings → Admin → Members for the link`,
      );
      setEmail("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't invite.");
    } finally {
      setInviting(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <UserPlus className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Add another person</h2>
          <p className="text-xs text-muted-foreground">
            Give an employee of this client their own login. Full roster +
            pending invites live at Settings → Admin → Members.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1 space-y-1.5">
          <Label htmlFor="ob-invite-email" className="text-xs">
            Email
          </Label>
          <Input
            id="ob-invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-invite-role" className="text-xs">
            Role
          </Label>
          <select
            id="ob-invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "collaborator")}
            className="h-9 w-48 rounded-md border border-input bg-background py-0 pl-3 pr-8 text-sm"
          >
            <option value="collaborator">Collaborator</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Button type="button" onClick={handleInvite} disabled={inviting}>
          {inviting ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
          )}
          Invite
        </Button>
      </div>
    </section>
  );
}

/** Points the operator at the settings pages for the messages/instructions
 *  that need per-client customization — this section has no fields of its
 *  own, just links to where the real config lives. */
function CustomizationPointers() {
  const { saPath } = useSubAccount();
  const items = [
    {
      icon: <Star className="h-4 w-4" />,
      tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      title: "Google review messages",
      desc: "The ask, confirm, and thank-you texts sent when requesting a review.",
      href: saPath("/dashboard/settings"),
      linkLabel: "Settings → Messaging → Google reviews",
    },
    {
      icon: <PhoneMissed className="h-4 w-4" />,
      tone: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      title: "Missed call text-back",
      desc: "What gets texted automatically when a call is missed.",
      href: saPath("/dashboard/settings"),
      linkLabel: "Settings → Messaging → SMS",
    },
    {
      icon: <MessageSquareText className="h-4 w-4" />,
      tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      title: "AI instructions",
      desc: "The persona + business hours + escalation rules the AI follows on every channel.",
      href: saPath("/ai-agents"),
      linkLabel: "AI Agents → Overview",
    },
  ];

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Compass className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Where to customize</h2>
          <p className="text-xs text-muted-foreground">
            The messages below aren&apos;t edited here — here&apos;s where to
            go for each.
          </p>
        </div>
      </div>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.title} className="flex items-start gap-3">
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                item.tone,
              )}
            >
              {item.icon}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">{item.desc}</p>
              <Link
                href={item.href}
                className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                {item.linkLabel}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
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

  const [hydrated, setHydrated] = useState(false);
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
      <OldLeadsUpload />
      <CustomizationPointers />

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

        <AddPersonInline />

        <section className="rounded-2xl border bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400">
              <ImageIcon className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Logo</h2>
              <p className="text-xs text-muted-foreground">
                Renders on the Dashboard, quotes/invoices, and the public
                quote page. Paste a public image link — host it on Google
                Drive (shared as &ldquo;Anyone with the link&rdquo;), Dropbox, or your
                own site, then paste the direct link here.
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
            <Input
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://…"
              type="url"
              className="flex-1"
            />
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
