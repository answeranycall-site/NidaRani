import type { Timestamp, FieldValue } from "firebase/firestore";
import type { BroadcastAudienceFilter } from "./broadcasts";

/**
 * Cold SMS bulk campaign — mirrors the Outbound Voice Campaign architecture
 * (`voice-campaigns.ts`) almost exactly, with one structural difference:
 * voice campaigns fan out with one GLOBAL linear stagger against a single
 * per-minute cap; SMS campaigns delegate pacing entirely to the per-number
 * rate limiter already built in `lib/comms/sms-pool.ts::reserveSendSlot` —
 * every recipient fans out with zero precomputed delay, and each number's
 * own durable cursor is what actually paces sends. See the campaign send/
 * step routes under `api/comms/sms/campaign/`.
 */

export type SmsCampaignStatus =
  /** Audience resolved + rebalanced, recipients queued, QStash fanned out. */
  | "queued"
  /** First send has settled; at least one row has left "queued". */
  | "sending"
  /** Every row has settled (sent / skipped / failed). */
  | "completed"
  /** Operator hit the stop button — no further sends are placed. */
  | "cancelled"
  /** Hard-failed during creation (e.g. empty pool, QStash misconfigured). */
  | "failed";

export interface SmsCampaignTotals {
  /** Contacts the audience query returned (before pre-flight skip). */
  audienceSize: number;
  /** Recipients still waiting to be sent (or being deferred by their
   *  number's rate limiter). */
  queued: number;
  /** Recipients an actual send was placed for. */
  sent: number;
  /** Recipients dropped before sending (opted out, no phone, assigned
   *  number disabled — see the recipient's `skippedReason`). */
  skipped: number;
  /** Recipients where the send itself errored at the Twilio layer. */
  failed: number;
}

export interface SmsCampaignDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  /** Auto-issued audit code, e.g. "SC-2026-0001" (per sub-account). */
  code: string;
  /** Optional operator-given label, e.g. "March cold batch — TN/MO/GA". */
  name: string;
  audienceFilter: BroadcastAudienceFilter;
  /** The operator's original draft, plus any AI-suggested variants they
   *  approved. Always at least 1 entry (falls back to just the draft if
   *  variants were never generated). The step picks one per recipient,
   *  round-robin by recipient index, before merge-tag resolution. */
  messageVariants: string[];
  status: SmsCampaignStatus;
  totals: SmsCampaignTotals;
  /** How many contacts this campaign's rotation-balance pass reassigned to
   *  a different number than they came in with (audit/debug visibility —
   *  see the send route). */
  rebalancedCount: number;
  /** Numbers bought at launch time to close a sizing gap, if any (audit). */
  numbersBoughtAtLaunch: number;
  /** Resolved once at launch (agency owner's display name/email) so the
   *  per-recipient step never needs its own lookup — see the merge-tag
   *  {{owner.*}} tags. */
  ownerSnapshot: { displayName: string; email: string };
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  startedAt: Timestamp | FieldValue | null;
  completedAt: Timestamp | FieldValue | null;
  errorMessage: string | null;
}

export type SmsCampaignSkipReason =
  | "opted_out"
  | "no_phone"
  | "number_disabled"
  | "pool_empty"
  | "cancelled";

export type SmsCampaignRecipientStatus = "queued" | "sent" | "skipped" | "failed";

export interface SmsCampaignRecipientDoc {
  id: string; // === contactId
  campaignId: string;
  agencyId: string;
  subAccountId: string;
  contactId: string;
  /** Snapshot of the contact's phone + name at fan-out time. */
  toPhone: string;
  toName: string;
  /** The number this recipient will send/sent from — resolved (and
   *  possibly rebalanced) at fan-out time, per the "pin only after a real
   *  send" rule. */
  fromNumber: string;
  /** Which of the campaign's `messageVariants` this recipient got. */
  variantIndex: number;
  status: SmsCampaignRecipientStatus;
  skippedReason: SmsCampaignSkipReason | null;
  sid: string | null;
  error: string | null;
  queuedAt: Timestamp | FieldValue | null;
  settledAt: Timestamp | FieldValue | null;
}
