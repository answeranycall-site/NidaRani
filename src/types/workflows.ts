import type { Timestamp, FieldValue } from "firebase/firestore";
import type { PipelineStageId } from "./deals";

/**
 * Workflow Builder — the general automation engine that replaces the legacy
 * single-recipe `automations` engine. A workflow is a TRIGGER + a graph of
 * NODES (linear with if/else branches). A RUN is one contact's enrollment
 * walking that graph; the QStash step worker advances it node by node.
 */

export type WorkflowStatus = "draft" | "active" | "paused";

export type WorkflowTriggerType =
  | "contact.created"
  | "contact.tag.added"
  | "form.submitted"
  | "pipeline.stage.changed"
  | "booking.created"
  | "quote.accepted"
  | "sms.keyword_received";

/* ------------------------------ Conditions ----------------------------- */

export type ConditionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "is_set"
  | "not_set"
  | "has_tag"
  | "in_stage"
  | "source_is";

export interface Condition {
  /** Contact field path (e.g. "email", "company", "customFields.x"). */
  field: string;
  op: ConditionOp;
  value?: string;
}

/** v1: a single AND list. OR/nested groups are a v2 add. */
export interface ConditionGroup {
  all: Condition[];
}

/* -------------------------------- Trigger ------------------------------ */

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  filters: ConditionGroup;
  /** Restrict `form.submitted` to one form. Null/absent = any form. */
  formId?: string | null;
  /** Restrict `pipeline.stage.changed` to one target stage. */
  toStage?: string | null;
  /** Required for `sms.keyword_received` — the inbound SMS body must match
   *  this word/phrase exactly (trimmed, case-insensitive) on the
   *  sub-account's own dedicated Twilio number. Shared-sender mode can't
   *  fire this trigger (no per-sub-account inbound routing). */
  keyword?: string | null;
}

/* --------------------------------- Nodes ------------------------------- */

export type WorkflowNodeType =
  | "send_email"
  | "send_sms"
  | "whatsapp_template"
  | "wait"
  | "if_else"
  | "goal"
  | "add_tag"
  | "remove_tag"
  | "move_stage"
  | "update_field"
  | "create_task"
  | "notify"
  | "notify_owner_sms"
  | "review_rating_request"
  | "review_rating_reminder"
  | "webhook"
  | "ai_propose_booking"
  | "ai_await_booking_reply"
  | "ai_booking_resolver"
  | "move_deal_stage";

/**
 * Node types whose `next` graph continuation lives in `branches` rather than
 * `next` — the builder tree flattener/parser and the UI's chain renderer
 * both need to know this set to route branch-vs-linear steps correctly.
 * `if_else` evaluates a condition; `ai_booking_resolver` branches on whether
 * an AI-initiated SMS booking (see `ai_propose_booking`) actually landed.
 */
export const BRANCHING_NODE_TYPES: readonly WorkflowNodeType[] = [
  "if_else",
  "ai_booking_resolver",
];

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Node-type-specific config (validated per type at execution). */
  config: Record<string, unknown>;
  /** Next node for a linear step. Null/absent ends the run. */
  next?: string | null;
  /** Branch targets for a branching node type (see `BRANCHING_NODE_TYPES`). */
  branches?: { whenTrue: string | null; whenFalse: string | null };
}

export interface WorkflowDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  name: string;
  status: WorkflowStatus;
  trigger: WorkflowTrigger;
  /** Entry node id. Null = empty workflow (won't enroll). */
  startNodeId: string | null;
  nodes: Record<string, WorkflowNode>;
  stats: { enrolled: number; completed: number };
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/* --------------------------------- Runs -------------------------------- */

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "exited";

export interface WorkflowRunHistoryEntry {
  nodeId: string;
  type: WorkflowNodeType;
  at: Timestamp | FieldValue | null;
  /** "ok" | "skipped:<reason>" | "error:<msg>" | "branch:true|false". */
  result: string;
}

export interface WorkflowRunDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  workflowId: string;
  contactId: string;
  status: WorkflowRunStatus;
  currentNodeId: string | null;
  history: WorkflowRunHistoryEntry[];
  /** Trigger payload snapshot (e.g. { formId, dealId }). */
  context: Record<string, unknown>;
  qstashMessageId: string | null;
  enrolledAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/* ------------------------ Node config (typed views) -------------------- */

export interface SendEmailConfig {
  subject: string;
  body: string;
}
export interface SendSmsConfig {
  body: string;
}
export interface WhatsappTemplateConfig {
  /** Approved WhatsApp template doc id (subAccounts/{id}/whatsappTemplates). */
  templateId: string;
  /**
   * Operator-set values for the template's MANUAL variables, keyed by position
   * (string keys for JSON). May contain merge tags; resolved at run time.
   * `merge_tag` variables auto-resolve from the contact and aren't stored here.
   */
  manualValues?: Record<string, string>;
}
export interface WaitConfig {
  seconds: number;
}
export interface IfElseConfig {
  conditions: ConditionGroup;
}
export interface TagConfig {
  tag: string;
}
export interface MoveStageConfig {
  stage: string;
}
export interface UpdateFieldConfig {
  field: string;
  value: string;
}
export interface CreateTaskConfig {
  title: string;
  dueInDays?: number;
}
/** Who an Internal notification step emails. Legacy configs predate this
 *  field — the engine treats a missing value like "custom" (use `to`, else
 *  fall back to the agency owner) for backward compatibility. */
export type NotifyRecipient = "owner" | "account_contact" | "custom";

export interface NotifyConfig {
  /** Recipient mode. Optional so pre-existing stored configs still parse. */
  recipient?: NotifyRecipient;
  /** Literal email — only used when `recipient` is "custom" (or absent). */
  to: string;
  subject: string;
  body: string;
}
export interface WebhookConfig {
  url: string;
}
/**
 * Sends an SMS to the business OWNER (subAccount.accountContact.phone), not
 * the contact/lead — an internal heads-up, not a customer-facing message.
 * Supports the same contact/owner/workspace merge tags as send_sms
 * ({{contact.firstName}}, {{contact.lastName}}, {{contact.phone}}, etc. —
 * see lib/automations/merge-tags.ts), PLUS two review-specific tokens,
 * {{reviewRating}} / {{reviewOutcome}}, populated when this step follows a
 * `review_rating_request` step. Reuses the same Twilio send path as
 * send_sms, just with a fixed recipient instead of contact.phone.
 */
export interface NotifyOwnerSmsConfig {
  body: string;
}
/**
 * Asks the contact to rate their experience 1-5 (SMS, dedicated Twilio only)
 * instead of sending the Google review link directly. Reuses the sub-account's
 * Settings → Messaging → "Review requests" config (review URL + templates) —
 * this node has no config of its own. A reply of 4-5 gets the Google link; 1-3
 * gets the configured internal-feedback message + a follow-up Task — this
 * send/don't-send decision is always a hard rule on the number, never an AI
 * judgment call. A clean single-digit reply is held ~30s before committing
 * (lib/reviews/constants.ts::RATING_HOLD_WINDOW_SEC) in case a same-minute
 * correction arrives; the OpenRouter-backed disambiguator (same one the
 * Settings-driven rating gate uses — see lib/reviews/rating-reply.ts) only
 * gets involved for genuinely ambiguous replies (2+ numbers in one message, a
 * conflicting follow-up message, or free text with no digit), and always
 * confirms its guess with the contact before it's treated as final.
 *
 * As soon as the ask sends successfully, the business owner
 * (subAccount.accountContact.phone) gets an immediate "A review request was
 * sent to {name} ({phone})." text — separate from, and ahead of, the
 * eventual outcome notification a downstream `notify_owner_sms` step sends.
 *
 * The run pauses here (status "waiting") until the customer replies or 7 days
 * elapse (whichever comes first — lib/reviews/constants.ts::RATING_REPLY_
 * WINDOW_MS). The next node in the graph (typically `notify_owner_sms`) can
 * reference `{{reviewRating}}` and `{{reviewOutcome}}`, populated once the
 * reply resolves.
 */
export type ReviewRatingRequestConfig = Record<string, never>;

/**
 * One-time follow-up for `review_rating_request`'s 7-day no-reply timeout —
 * no config of its own. Texts the owner the window lapsed, resends the same
 * ask to the contact (bypassing the normal cooldown), texts the owner the
 * reminder went out, and re-arms another 7-day wait. A transparent
 * passthrough when the contact already replied to the first ask — safe to
 * place unconditionally right after `review_rating_request`. See
 * lib/workflows/engine.ts::execReviewRatingReminder for the full picture.
 */
export type ReviewRatingReminderConfig = Record<string, never>;

/**
 * AI Booking + Nurture — SMS booking chain (Phase 1). Every AI-drafted
 * message this chain sends queues in Conversations for human approval
 * before it goes out (no auto-send); see `lib/workflows/engine.ts::
 * armApprovalWait`. Reads the sub-account's real Booking Page availability
 * (`lib/booking/availability.ts::computeAvailability`), so proposed slots
 * are always real, never invented by the model.
 *
 * The chain is 3 node types because a paused node can only be woken by an
 * external event (an approval, or the contact's reply) by handing off to a
 * DIFFERENT node id — `runStep`'s per-nodeId idempotency guard means a given
 * node's executor body runs exactly once, ever, in a run:
 *
 *   ai_propose_booking → ai_await_booking_reply → ai_booking_resolver
 *        (drafts,             (drafts nothing —        (branch node —
 *         arms approval-       arms the reply-wait       whenTrue once
 *         wait)                once approved)            run.context.booking
 *                                                         is populated)
 *
 * Place `move_deal_stage` (or any other node) on the resolver's `whenTrue`
 * branch; wire `whenFalse` to a human-handoff step (e.g. `notify_owner_sms`).
 */
export interface AiProposeBookingConfig {
  /** subAccounts/{id}/bookingPages/{slug} — the slug to offer slots from. */
  bookingPageId: string;
  /** How many days out to look for open slots. */
  daysAhead: number;
  /** Max slot options to offer in the proposal SMS. */
  maxSlotOptions: number;
  /** Optional extra tone/style guidance for the AI-drafted proposal text. */
  toneInstructions?: string;
  /** How long the drafted proposal waits for operator approval before the
   *  run falls through to `ai_booking_resolver`'s `whenFalse`. Default 24h. */
  approvalTimeoutSeconds?: number;
  /** Once approved + sent, how long to wait for the contact to pick a slot
   *  before falling through to `whenFalse`. Default 48h. */
  replyTimeoutSeconds?: number;
}

/** No config of its own — see `AiProposeBookingConfig`'s doc comment. */
export type AiAwaitBookingReplyConfig = Record<string, never>;

/** No config of its own (branch node, like `if_else`) — see
 *  `AiProposeBookingConfig`'s doc comment. */
export type AiBookingResolverConfig = Record<string, never>;

/**
 * Finds the contact's open (non-terminal) deal and moves it to `stageId`, or
 * creates one if none exists. General-purpose (not booking-specific) —
 * reuses `lib/server/deals-service.ts::createDealServerSide` /
 * `updateDealServerSide` so webhooks + activity logging stay consistent with
 * every other deal write path.
 */
export interface MoveDealStageConfig {
  stageId: PipelineStageId;
  /** Only used when creating a new deal (no open deal found). */
  dealTitle?: string;
  /** Only used when creating a new deal. Defaults to 0. */
  dealValue?: number;
}
