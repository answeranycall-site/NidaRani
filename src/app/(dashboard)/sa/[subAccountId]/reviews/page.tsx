"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ExternalLink,
  Lock,
  MapPin,
  Phone,
  RefreshCw,
  Star,
  Unplug,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToGoogleReviews } from "@/lib/firestore/google-reviews";
import { formatRelativeTime, toDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import type { GoogleReviewDoc } from "@/types/reviews";

/**
 * Reviews — pulls the sub-account's actual Google Business Profile reviews
 * (business info + review feed) into the CRM. Gated by
 * `googleReviewsSyncEnabledByAgency`; renders a locked state when off.
 * Distinct from Settings → Messaging's Google review-REQUEST section,
 * which just sends "leave us a review" links — this is the two-way
 * connection that reads reviews back (see the Firestore Collections table
 * / "Google Reviews Sync" in CLAUDE.md).
 */

const STATUS_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Business Profile connected." },
  cancelled: { ok: false, text: "Connection cancelled." },
  bad_state: { ok: false, text: "Connection failed a security check. Try again." },
  not_configured: {
    ok: false,
    text: "Google Reviews Sync isn't configured on this deployment yet (missing Google OAuth credentials).",
  },
  gate_off: { ok: false, text: "This feature is locked by your agency." },
  no_accounts: {
    ok: false,
    text: "No Google Business Profile accounts were available on that Google login.",
  },
  no_locations: {
    ok: false,
    text: "That Business Profile account has no locations to connect.",
  },
  no_refresh_token: {
    ok: false,
    text: "Google didn't return a long-lived connection. Disconnect (if shown) and try connecting again.",
  },
  error: { ok: false, text: "Couldn't connect to Google. Please try again." },
};

function StarRow({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={
            n <= rating
              ? "h-3.5 w-3.5 fill-amber-400 text-amber-400"
              : "h-3.5 w-3.5 text-muted-foreground/30"
          }
        />
      ))}
    </span>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Reviews</h1>
      <p className="text-sm text-muted-foreground">
        Your Google Business Profile reviews, synced into the CRM.
      </p>
    </div>
  );
}

export default function ReviewsPage() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const gateOn = subAccount?.googleReviewsSyncEnabledByAgency === true;
  const cfg = subAccount?.googleBusinessConfig ?? null;
  const [reviews, setReviews] = useState<GoogleReviewDoc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("gbp");
    if (!status) return;
    const msg = STATUS_MESSAGES[status];
    if (msg) {
      if (msg.ok) toast.success(msg.text);
      else toast.error(msg.text);
    }
    params.delete("gbp");
    const qs = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  useEffect(() => {
    if (!subAccountId || !gateOn || !cfg) return;
    const unsub = subscribeToGoogleReviews(
      subAccountId,
      (list) => {
        setReviews(list);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
    return () => unsub();
  }, [subAccountId, gateOn, cfg]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google-business/sync`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        newReviewCount?: number;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Sync failed.");
      toast.success(
        data.newReviewCount && data.newReviewCount > 0
          ? `Synced — ${data.newReviewCount} new review${data.newReviewCount === 1 ? "" : "s"}.`
          : "Synced — no new reviews.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect this Google Business Profile? Synced reviews stay, but new ones stop syncing until you reconnect.")) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google-business`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Couldn't disconnect.");
      toast.success("Disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  if (!gateOn) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Lock className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-base font-semibold">
            Reviews is locked by your agency
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Ask your agency owner to enable Google Reviews Sync for this
            sub-account.
          </p>
        </div>
      </div>
    );
  }

  if (!isAdmin && !cfg) {
    // Non-admins can't connect; just show a friendlier empty state than
    // pointing them at the connect button.
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          No Google Business Profile connected yet. Ask a sub-account admin to
          connect one.
        </div>
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-2xl border bg-card p-8 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Star className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-base font-semibold">
            Connect your Google Business Profile
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            See your actual Google reviews right here, and get texted the
            moment a new one lands.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              window.location.href = `/api/sub-accounts/${subAccountId}/google-business/connect`;
            }}
          >
            Connect Google Business Profile
          </Button>
        </div>
      </div>
    );
  }

  const lastSynced = toDate(cfg.lastSyncedAt);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Header />
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncNow}
              disabled={syncing}
            >
              <RefreshCw className={syncing ? "mr-1.5 h-3.5 w-3.5 animate-spin" : "mr-1.5 h-3.5 w-3.5"} />
              Sync now
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              <Unplug className="mr-1.5 h-3.5 w-3.5" />
              Disconnect
            </Button>
          </div>
        )}
      </div>

      <section className="rounded-2xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{cfg.locationName}</h2>
            <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
              {cfg.address && (
                <p className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  {cfg.address}
                </p>
              )}
              {cfg.phone && (
                <p className="flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  {cfg.phone}
                </p>
              )}
            </div>
          </div>
          <div className="text-right">
            {cfg.averageRating != null && (
              <div className="flex items-center justify-end gap-2">
                <StarRow rating={Math.round(cfg.averageRating)} />
                <span className="text-lg font-semibold">
                  {cfg.averageRating.toFixed(1)}
                </span>
              </div>
            )}
            {cfg.totalReviewCount != null && (
              <p className="text-xs text-muted-foreground">
                {cfg.totalReviewCount} review{cfg.totalReviewCount === 1 ? "" : "s"}
              </p>
            )}
            {cfg.mapsUri && (
              <a
                href={cfg.mapsUri}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline"
              >
                View on Google Maps
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {lastSynced
            ? `Last synced ${formatRelativeTime(lastSynced)}.`
            : "Not synced yet — click Sync now."}
          {cfg.lastSyncError && (
            <span className="ml-1 text-destructive">
              Last sync failed: {cfg.lastSyncError}
            </span>
          )}
        </p>
      </section>

      <section className="space-y-3">
        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading reviews…</p>
        ) : reviews.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
            No reviews synced yet.
          </div>
        ) : (
          reviews.map((r) => {
            const created = toDate(r.createTime);
            return (
              <div key={r.id} className="rounded-2xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {r.reviewerPhotoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.reviewerPhotoUrl}
                        alt=""
                        className="h-8 w-8 rounded-full"
                      />
                    ) : (
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                        {r.reviewerName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div>
                      <p className="text-sm font-medium">{r.reviewerName}</p>
                      <StarRow rating={r.starRating} />
                    </div>
                  </div>
                  {created && (
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(created)}
                    </span>
                  )}
                </div>
                {r.comment && (
                  <p className="mt-2 text-sm text-foreground/90">{r.comment}</p>
                )}
                {r.reviewReply && (
                  <div className="mt-2 rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Owner reply: </span>
                    {r.reviewReply.comment}
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
