import {
  collection,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { GoogleReviewDoc } from "@/types/reviews";

/**
 * Client-side subscription for the Reviews page's synced Google review
 * feed. All writes go through lib/comms/google-business/sync.ts via the
 * Admin SDK (cron + manual sync-now route) — googleReviews is read-only for
 * members at the rules level.
 */
export function subscribeToGoogleReviews(
  subAccountId: string,
  callback: (reviews: GoogleReviewDoc[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/googleReviews`),
    orderBy("createTime", "desc"),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<GoogleReviewDoc, "id">) }),
      );
      callback(list);
    },
    (err) => onError?.(err),
  );
}
