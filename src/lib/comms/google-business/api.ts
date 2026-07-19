import "server-only";

/**
 * Google Business Profile REST calls used by the connect flow + review sync.
 * Three separate Google API surfaces are involved (Google split "My
 * Business API" into several services over the years):
 *   - Account Management API  — which Business Profile accounts the user manages.
 *   - Business Information API — location details (name/address/phone/etc).
 *   - The legacy `mybusiness.googleapis.com/v4` surface — still the only
 *     place review read/reply lives; Google never migrated it to the new
 *     split APIs. Access to this surface's review methods requires Google's
 *     manual approval (see oauth.ts header comment).
 */

const ACCOUNTS_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const LEGACY_BASE = "https://mybusiness.googleapis.com/v4";

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

export interface GoogleBusinessAccount {
  name: string; // "accounts/{accountId}"
  accountId: string;
  accountName: string;
}

interface AccountsResponse {
  accounts?: Array<{ name?: string; accountName?: string }>;
}

/** List the Business Profile accounts the connecting user manages. */
export async function listGoogleBusinessAccounts(
  accessToken: string,
): Promise<GoogleBusinessAccount[]> {
  const res = await fetch(`${ACCOUNTS_BASE}/accounts`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new Error(`Google accounts fetch failed (${res.status})`);
  }
  const data = (await res.json()) as AccountsResponse;
  return (data.accounts ?? [])
    .filter((a): a is { name: string; accountName?: string } => !!a.name)
    .map((a) => ({
      name: a.name,
      accountId: a.name.split("/").pop() ?? a.name,
      accountName: a.accountName ?? "Business Profile account",
    }));
}

export interface GoogleBusinessLocation {
  locationId: string;
  name: string;
  address: string | null;
  phone: string | null;
  websiteUri: string | null;
  mapsUri: string | null;
}

interface LocationsResponse {
  locations?: Array<{
    name?: string; // "locations/{locationId}"
    title?: string;
    phoneNumbers?: { primaryPhone?: string };
    websiteUri?: string;
    storefrontAddress?: {
      addressLines?: string[];
      locality?: string;
      administrativeArea?: string;
      postalCode?: string;
    };
    metadata?: { mapsUri?: string };
  }>;
}

const READ_MASK =
  "name,title,phoneNumbers,websiteUri,storefrontAddress,metadata";

/** List the locations (branches) under a Business Profile account. */
export async function listGoogleBusinessLocations(
  accessToken: string,
  accountId: string,
): Promise<GoogleBusinessLocation[]> {
  const res = await fetch(
    `${INFO_BASE}/accounts/${accountId}/locations?readMask=${encodeURIComponent(READ_MASK)}`,
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) {
    throw new Error(`Google locations fetch failed (${res.status})`);
  }
  const data = (await res.json()) as LocationsResponse;
  return (data.locations ?? [])
    .filter((l): l is Required<Pick<typeof l, "name">> & typeof l => !!l.name)
    .map((l) => {
      const addr = l.storefrontAddress;
      const addressParts = [
        ...(addr?.addressLines ?? []),
        addr?.locality,
        addr?.administrativeArea,
        addr?.postalCode,
      ].filter(Boolean);
      return {
        locationId: l.name!.split("/").pop() ?? l.name!,
        name: l.title ?? "Business location",
        address: addressParts.length > 0 ? addressParts.join(", ") : null,
        phone: l.phoneNumbers?.primaryPhone ?? null,
        websiteUri: l.websiteUri ?? null,
        mapsUri: l.metadata?.mapsUri ?? null,
      };
    });
}

const STAR_RATING_MAP: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export interface GoogleBusinessReview {
  reviewId: string;
  reviewerName: string;
  reviewerPhotoUrl: string | null;
  starRating: number;
  comment: string;
  createTime: string;
  updateTime: string;
  reviewReply: { comment: string; updateTime: string } | null;
}

interface ReviewsResponse {
  reviews?: Array<{
    reviewId?: string;
    reviewer?: { displayName?: string; profilePhotoUrl?: string };
    starRating?: string;
    comment?: string;
    createTime?: string;
    updateTime?: string;
    reviewReply?: { comment?: string; updateTime?: string };
  }>;
  averageRating?: number;
  totalReviewCount?: number;
}

/**
 * List reviews for one location. NOTE: this is the legacy v4 "My Business
 * API" surface — Google never ported review read/reply to the newer split
 * APIs. Requires the `business.manage` scope AND (for anyone outside
 * Google's original partner allowlist) manual approval of that scope on
 * your OAuth consent screen for production use.
 */
export async function listGoogleBusinessReviews(
  accessToken: string,
  accountId: string,
  locationId: string,
): Promise<{
  reviews: GoogleBusinessReview[];
  averageRating: number | null;
  totalReviewCount: number | null;
}> {
  const res = await fetch(
    `${LEGACY_BASE}/accounts/${accountId}/locations/${locationId}/reviews`,
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) {
    throw new Error(`Google reviews fetch failed (${res.status})`);
  }
  const data = (await res.json()) as ReviewsResponse;
  const reviews = (data.reviews ?? [])
    .filter((r): r is Required<Pick<typeof r, "reviewId">> & typeof r => !!r.reviewId)
    .map((r) => ({
      reviewId: r.reviewId!,
      reviewerName: r.reviewer?.displayName ?? "A customer",
      reviewerPhotoUrl: r.reviewer?.profilePhotoUrl ?? null,
      starRating: STAR_RATING_MAP[r.starRating ?? ""] ?? 0,
      comment: r.comment ?? "",
      createTime: r.createTime ?? new Date().toISOString(),
      updateTime: r.updateTime ?? r.createTime ?? new Date().toISOString(),
      reviewReply: r.reviewReply?.comment
        ? {
            comment: r.reviewReply.comment,
            updateTime: r.reviewReply.updateTime ?? new Date().toISOString(),
          }
        : null,
    }));
  return {
    reviews,
    averageRating: data.averageRating ?? null,
    totalReviewCount: data.totalReviewCount ?? null,
  };
}
