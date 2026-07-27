"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Globe, ImageIcon, Mail, Phone } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";

/**
 * Top-of-Dashboard masthead — the at-a-glance identity card. Read-only
 * display of every field, all of which are actually edited in Client
 * Onboarding below (name, contact, website, review link, logo) or
 * Settings (Twilio number). Replaces the old plain "Welcome back" heading
 * + the separate account-contact/SMS-number bars.
 *
 * The logo is a pasted public image URL (Client Onboarding → Logo), not
 * an upload — this deployment doesn't have Firebase Storage enabled, so
 * there's nowhere to receive an uploaded file.
 */
export function DashboardMasthead() {
  const { subAccountId, subAccount, isAdmin, saPath } = useSubAccount();
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!subAccountId) return;
    fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`)
      .then((r) => r.json())
      .then((data: { profile?: { websiteUrl?: string | null } | null }) => {
        setWebsiteUrl(data.profile?.websiteUrl ?? null);
      })
      .catch(() => {});
  }, [subAccountId]);

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
