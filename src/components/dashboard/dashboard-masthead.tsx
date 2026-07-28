"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Building2, Globe, ImageIcon, Mail, Phone } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { INDUSTRY_OPTIONS, OTHER_INDUSTRY } from "@/lib/industries";

/**
 * Top-of-Dashboard masthead — the at-a-glance identity card. Mostly
 * read-only display of fields actually edited in Client Onboarding below
 * (name, contact, website, review link, logo) or Settings (Twilio
 * number) — EXCEPT Industry + LTV, which save directly from here since
 * they're referenced constantly in SMS templates ({{industry}} /
 * {{ltv}}) and the operator wanted them front-and-center. Replaces the
 * old plain "Welcome back" heading + the separate account-contact/
 * SMS-number bars.
 *
 * The logo is a pasted public image URL (Client Onboarding → Logo), not
 * an upload — this deployment doesn't have Firebase Storage enabled, so
 * there's nowhere to receive an uploaded file.
 */
export function DashboardMasthead() {
  const { subAccountId, subAccount, isAdmin, saPath } = useSubAccount();
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);

  const [industryPreset, setIndustryPreset] = useState("");
  const [industryCustom, setIndustryCustom] = useState("");
  const [industryHydrated, setIndustryHydrated] = useState(false);
  const [ltvInput, setLtvInput] = useState("");
  const [ltvHydrated, setLtvHydrated] = useState(false);
  const [savingIndustry, setSavingIndustry] = useState(false);
  const [savingLtv, setSavingLtv] = useState(false);

  useEffect(() => {
    if (!subAccountId) return;
    fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`)
      .then((r) => r.json())
      .then((data: { profile?: { websiteUrl?: string | null } | null }) => {
        setWebsiteUrl(data.profile?.websiteUrl ?? null);
      })
      .catch(() => {});
  }, [subAccountId]);

  useEffect(() => {
    if (industryHydrated || !subAccount) return;
    const raw = subAccount.industry ?? "";
    if (raw && INDUSTRY_OPTIONS.includes(raw)) {
      setIndustryPreset(raw);
      setIndustryCustom("");
    } else if (raw) {
      setIndustryPreset(OTHER_INDUSTRY);
      setIndustryCustom(raw);
    }
    setIndustryHydrated(true);
  }, [industryHydrated, subAccount]);

  useEffect(() => {
    if (ltvHydrated || !subAccount) return;
    setLtvInput(
      typeof subAccount.ltv === "number" && subAccount.ltv > 0
        ? String(subAccount.ltv)
        : "",
    );
    setLtvHydrated(true);
  }, [ltvHydrated, subAccount]);

  async function saveIndustry(value: string | null) {
    setSavingIndustry(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ industry: value }),
      });
      if (!res.ok) throw new Error("save failed");
    } catch {
      toast.error("Couldn't save industry.");
    } finally {
      setSavingIndustry(false);
    }
  }

  function handlePresetChange(next: string) {
    setIndustryPreset(next);
    if (next === OTHER_INDUSTRY) return; // wait for custom text below
    void saveIndustry(next || null);
  }

  async function saveLtv() {
    const trimmed = ltvInput.trim();
    const parsed = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isFinite(parsed) || (parsed as number) < 0)) {
      toast.error("LTV must be a positive number.");
      return;
    }
    setSavingLtv(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ltv: parsed }),
      });
      if (!res.ok) throw new Error("save failed");
    } catch {
      toast.error("Couldn't save LTV.");
    } finally {
      setSavingLtv(false);
    }
  }

  const businessName = subAccount?.name ?? "Your business";
  const dedicatedNumber =
    subAccount?.twilioConfig?.enabled && subAccount.twilioConfig.fromNumber
      ? subAccount.twilioConfig.fromNumber
      : null;
  const contact = subAccount?.accountContact ?? null;
  const hasContact =
    !!contact && (!!contact.name || !!contact.email || !!contact.phone);
  const logoUrl = subAccount?.logoUrl ?? null;

  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-4">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted/40">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={`${businessName} logo`}
              className="h-full w-full object-contain p-1.5"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </span>

        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">
            {businessName}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
            {dedicatedNumber ? (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                {dedicatedNumber}
              </span>
            ) : isAdmin ? (
              <Link
                href={saPath("/dashboard/settings")}
                className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
              >
                <Phone className="h-3.5 w-3.5" />
                No dedicated number yet — set one up
              </Link>
            ) : null}
            {websiteUrl && (
              <a
                href={websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
              >
                <Globe className="h-3.5 w-3.5" />
                {websiteUrl.replace(/^https?:\/\//, "")}
              </a>
            )}
          </p>

          {isAdmin ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Industry:
                </span>
                <select
                  value={industryPreset}
                  onChange={(e) => handlePresetChange(e.target.value)}
                  disabled={savingIndustry}
                  className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                >
                  <option value="">Select…</option>
                  {INDUSTRY_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                  <option value={OTHER_INDUSTRY}>{OTHER_INDUSTRY}</option>
                </select>
                {industryPreset === OTHER_INDUSTRY && (
                  <input
                    type="text"
                    value={industryCustom}
                    onChange={(e) => setIndustryCustom(e.target.value)}
                    onBlur={() => void saveIndustry(industryCustom.trim() || null)}
                    placeholder="Type your industry"
                    disabled={savingIndustry}
                    className="h-7 w-40 rounded-md border border-input bg-background px-1.5 text-xs"
                  />
                )}
              </label>

              <label className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  LTV:
                </span>
                <span className="text-xs text-muted-foreground">$</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={ltvInput}
                  onChange={(e) => setLtvInput(e.target.value)}
                  onBlur={saveLtv}
                  disabled={savingLtv}
                  placeholder="2500"
                  title="What one customer is worth to your business over time — first job plus referrals and repeat work."
                  className="h-7 w-24 rounded-md border border-input bg-background px-1.5 text-xs"
                />
              </label>
            </div>
          ) : null}
          {isAdmin && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              LTV = what one customer is worth to your business over time —
              first job plus referrals and repeat work.
            </p>
          )}
          {!isAdmin && (
            (subAccount?.industry || subAccount?.ltv) && (
              <p className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                {subAccount?.industry && <span>Industry: {subAccount.industry}</span>}
                {!!subAccount?.ltv && (
                  <span>LTV: ${subAccount.ltv.toLocaleString("en-US")}</span>
                )}
              </p>
            )
          )}
        </div>
      </div>

      {hasContact && contact && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5" />
            {contact.name && <span className="text-foreground">{contact.name}</span>}
            {contact.email && (
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3 w-3" />
                {contact.email}
              </span>
            )}
            {contact.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="h-3 w-3" />
                {contact.phone}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
