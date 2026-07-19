import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * A single synced Google review, stored at
 * `subAccounts/{id}/googleReviews/{reviewId}` (doc id = the review's Google
 * resource id, for natural dedup across syncs). Written only by
 * lib/comms/google-business/sync.ts — member-read / server-write in
 * firestore.rules, same shape as `metaMessages` / `whatsappMessages`.
 */
export interface GoogleReviewDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  reviewerName: string;
  reviewerPhotoUrl: string | null;
  /** 1-5. Google's API returns a string enum (STAR_RATING_UNSPECIFIED,
   *  ONE..FIVE) — sync.ts normalizes it to a number. */
  starRating: number;
  comment: string;
  /** When the review was left, per Google. */
  createTime: Timestamp | FieldValue | Date;
  /** When the review (or the owner's reply) was last edited, per Google. */
  updateTime: Timestamp | FieldValue | Date;
  reviewReply: { comment: string; updateTime: Timestamp | FieldValue | Date } | null;
  /** True the first sync a review is seen — used to decide whether to fire
   *  the owner "new review" SMS; false on subsequent re-syncs of the same
   *  review (e.g. the owner replied, or the text was edited). */
  firstSeenAt: Timestamp | FieldValue | Date;
}
