"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import {
  Building2,
  Globe,
  ImageIcon,
  Loader2,
  Mail,
  Phone,
  Star,
  UserPlus,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseStorage } from "@/lib/firebase/client";

/**
 * Top-of-Dashboard masthead — the at-a-glance identity card. Read-only
 * display of fields that are actually edited in Client Onboarding below
 * (name, contact, website, review link) or Settings (Twilio number),
 * EXCEPT the logo, which is directly upload-able here since that's the
 * one field visually anchored to this header. Replaces the old plain
 * "Welcome back" heading + the separate account-contact/SMS-number bars.
 */
const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB, matches storage.rules

export function DashboardMasthead() {
  const { subAccountId, subAccount, isAdmin, saPath } = useSubAccount();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
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

  async function handleLogoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
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
      const res = await fetch(`/api/sub-accounts/${subAccountId}/branding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoUrl: url }),
      });
      if (!res.ok) throw new Error("save failed");
      toast.success("Logo updated.");
    } catch {
      toast.error("Couldn't upload that image.");
    } finally {
      setUploadingLogo(false);
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
  const reviewUrl = subAccount?.googleReviewConfig?.reviewUrl ?? null;
  const logoUrl = subAccount?.logoUrl ?? null;

  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => isAdmin && fileInputRef.current?.click()}
          disabled={!isAdmin || uploadingLogo}
          title={isAdmin ? "Upload logo" : undefined}
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted/40 transition-colors hover:border-primary/40 disabled:cursor-default"
        >
          {uploadingLogo ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : logoUrl ? (
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
        </button>
        {isAdmin && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleLogoFileChange}
          />
        )}

        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">
            {businessName}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
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
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-3 text-xs text-muted-foreground">
        {hasContact && contact && (
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
        )}
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
        {reviewUrl && (
          <a
            href={reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
          >
            <Star className="h-3.5 w-3.5" />
            Google reviews
          </a>
        )}
        {isAdmin && (
          <Link
            href={saPath("/dashboard/settings")}
            className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add another person
          </Link>
        )}
        {!hasContact && !websiteUrl && !reviewUrl && (
          <span>Fill in your business details below to complete this card.</span>
        )}
      </div>
    </div>
  );
}
