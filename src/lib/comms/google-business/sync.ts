import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { refreshGoogleBusinessAccessToken } from "@/lib/comms/google-business/oauth";
import { listGoogleBusinessReviews } from "@/lib/comms/google-business/api";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import type { GoogleBusinessConfig, SubAccountDoc } from "@/types";

/**
 * Google Reviews Sync — the poll that keeps `subAccounts/{id}/googleReviews`
 * up to date and texts the owner when a genuinely new review lands. Google's
 * Business Profile API has no review webhook, so this only runs on demand
 * ("Sync now" button) or via the daily QStash cron
 * (/api/cron/google-reviews-sync — see lib/qstash/register-schedules.ts).
 *
 * Best-effort throughout: a sync failure is recorded on the config
 * (`lastSyncError`) and surfaced in the UI, but never thrown past the
 * caller — a cron sweep across many sub-accounts can't let one bad
 * connection abort the rest.
 */

function toMillis(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return 0;
}

async function ensureFreshAccessToken(
  subAccountId: string,
  cfg: GoogleBusinessConfig,
): Promise<string> {
  const expiresAtMs = toMillis(cfg.accessTokenExpiresAt);
  // Refresh a minute early so a slow request doesn't straddle expiry.
  if (expiresAtMs - Date.now() > 60_000) return cfg.accessToken;

  const refreshed = await refreshGoogleBusinessAccessToken(cfg.refreshToken);
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "googleBusinessConfig.accessToken": refreshed.accessToken,
      "googleBusinessConfig.accessTokenExpiresAt": refreshed.expiresAt,
      updatedAt: FieldValue.serverTimestamp(),
    });
  return refreshed.accessToken;
}

export interface SyncResult {
  ok: boolean;
  newReviewCount: number;
  error?: string;
}

/**
 * Sync one sub-account's reviews. Safe to call repeatedly (idempotent —
 * re-syncing an unchanged review just overwrites the same doc). Fires an
 * owner SMS for each review not previously seen in
 * `subAccounts/{id}/googleReviews`.
 */
export async function syncGoogleReviews(subAccountId: string): Promise<SyncResult> {
  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) return { ok: false, newReviewCount: 0, error: "Sub-account not found" };
  const sa = saSnap.data() as SubAccountDoc;
  const cfg = sa.googleReviewsSyncEnabledByAgency === true ? sa.googleBusinessConfig : null;
  if (!cfg) {
    return { ok: false, newReviewCount: 0, error: "Not connected or agency gate is off" };
  }

  try {
    const accessToken = await ensureFreshAccessToken(subAccountId, cfg);
    const { reviews, averageRating, totalReviewCount } =
      await listGoogleBusinessReviews(accessToken, cfg.accountId, cfg.locationId);

    // Which review ids do we already have? One collection read, not N gets.
    const existingSnap = await db
      .collection(`subAccounts/${subAccountId}/googleReviews`)
      .get();
    const existingIds = new Set(existingSnap.docs.map((d) => d.id));

    const newReviews = reviews.filter((r) => !existingIds.has(r.reviewId));

    // Upsert every review (new + updated) in batches of 500.
    for (let i = 0; i < reviews.length; i += 400) {
      const batch = db.batch();
      for (const r of reviews.slice(i, i + 400)) {
        const ref = db.doc(`subAccounts/${subAccountId}/googleReviews/${r.reviewId}`);
        batch.set(
          ref,
          {
            id: r.reviewId,
            agencyId: sa.agencyId,
            subAccountId,
            reviewerName: r.reviewerName,
            reviewerPhotoUrl: r.reviewerPhotoUrl,
            starRating: r.starRating,
            comment: r.comment,
            createTime: new Date(r.createTime),
            updateTime: new Date(r.updateTime),
            reviewReply: r.reviewReply
              ? { comment: r.reviewReply.comment, updateTime: new Date(r.reviewReply.updateTime) }
              : null,
            ...(existingIds.has(r.reviewId) ? {} : { firstSeenAt: FieldValue.serverTimestamp() }),
          },
          { merge: true },
        );
      }
      await batch.commit();
    }

    await db.doc(`subAccounts/${subAccountId}`).update({
      "googleBusinessConfig.averageRating": averageRating,
      "googleBusinessConfig.totalReviewCount": totalReviewCount,
      "googleBusinessConfig.lastSyncedAt": FieldValue.serverTimestamp(),
      "googleBusinessConfig.lastSyncError": null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Owner heads-up SMS per genuinely new review — same fixed-recipient
    // pattern as MCTB / notify_owner_sms (accountContact.phone).
    const ownerPhone = sa.accountContact?.phone?.trim();
    if (ownerPhone && newReviews.length > 0) {
      for (const r of newReviews) {
        try {
          await sendSmsForSubAccount({
            subAccountId,
            subAccount: sa,
            to: ownerPhone,
            body: `You received a new Google review of ${r.starRating} star${r.starRating === 1 ? "" : "s"}${
              r.comment ? `: "${r.comment.slice(0, 140)}"` : "."
            }`,
          });
        } catch (err) {
          console.warn(
            `[google-reviews] owner notify failed sa=${subAccountId} review=${r.reviewId}`,
            err,
          );
        }
      }
    }

    return { ok: true, newReviewCount: newReviews.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[google-reviews] sync failed sa=${subAccountId}: ${message}`);
    await db
      .doc(`subAccounts/${subAccountId}`)
      .update({
        "googleBusinessConfig.lastSyncError": message,
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    return { ok: false, newReviewCount: 0, error: message };
  }
}
