import type { Timestamp, FieldValue } from "firebase/firestore";

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
  | "quote.accepted";

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
  | "webhook";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Node-type-specific config (validated per type at execution). */
  config: Record<string, unknown>;
  /** Next node for a linear step. Null/absent ends the run. */
  next?: string | null;
  /** Branch targets for an `if_else` node. */
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
 * Sends a plain-text SMS to the business OWNER (subAccount.accountContact
 * .phone), not the contact/lead — an internal heads-up, not a customer-
 * facing message. No merge tags: unlike send_sms/notify, this is meant for
 * short fixed copy an operator types once ("we just texted back a missed
 * call from..."). Reuses the same Twilio send path as send_sms, just with
 * a fixed recipient instead of contact.phone.
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
