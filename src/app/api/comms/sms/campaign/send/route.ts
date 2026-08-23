import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { resolveSmsCampaignAudience } from "@/lib/comms/sms-campaign-audience";
import { issueSmsCampaignCode } from "@/lib/comms/sms-campaign-number";
import {
  assignCampaignRecipients,
  estimateCampaignDuration,
} from "@/lib/comms/sms-pool-assignment";
import { buyNumberForState } from "@/lib/comms/twilio-purchase";
import type {
  AgencyDoc,
  BroadcastAudienceFilter,
  SmsCampaignDoc,
  SmsCampaignRecipientDoc,
  SubAccountDoc,
  TwilioConfig,
  TwilioPoolNumber,
} from "@/types";

/** Mirrors lib/workflows/engine.ts's private loadOwner() — resolved once
 *  here and snapshotted onto the campaign doc so the per-recipient step
 *  never repeats this lookup. */
async function loadOwnerSnapshot(
  db: FirebaseFirestore.Firestore,
  agencyId: string,
): Promise<{ displayName: string; email: string }> {
  try {
    const agencySnap = await db.doc(`agencies/${agencyId}`).get();
    const agency = agencySnap.data() as AgencyDoc | undefined;
    if (!agency?.ownerUid) return { displayName: "", email: "" };
    const userSnap = await db.doc(`users/${agency.ownerUid}`).get();
    const d = userSnap.data();
    return {
      displayName: (d?.displayName as string) ?? "",
      email: (d?.email as string) ?? "",
    };
  } catch {
    return { displayName: "", email: "" };
  }
}

export const dynamic = "force-dynamic";

const MAX_AUDIENCE_SIZE = 25_000;
const MAX_VARIANTS = 6;

interface SendBody {
  subAccountId?: string;
  audienceFilter?: BroadcastAudienceFilter;
  name?: string;
  messageVariants?: string[];
  /** How many extra numbers to buy (any state) before fanning out — the
   *  operator confirms this quantity on the launch screen after seeing the
   *  duration estimate, same "ask before buying" pattern as CSV import. */
  buyExtraNumbers?: number;
}

/**
 * Kick off a Cold SMS bulk campaign. Resolves the audience, rotation-
 * balances every not-yet-locked contact evenly across the enabled pool
 * (see `assignCampaignRecipients`), creates the campaign + per-recipient
 * rows, and fans out to QStash with ZERO precomputed delay per recipient —
 * unlike the voice campaign's global stagger, pacing here is entirely
 * owned by each number's own durable rate-limit cursor
 * (`lib/comms/sms-pool.ts::reserveSendSlot`), invoked from inside the step
 * callback via `enqueuePooledSms`.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured — bulk sending needs the queue." },
      { status: 503 },
    );
  }

  let payload: SendBody;
  try {
    payload = (await request.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = payload.subAccountId?.trim();
  const audienceFilter = payload.audienceFilter;
  const draftMessage = (payload.messageVariants?.[0] ?? "").trim();
  if (!subAccountId || !audienceFilter || !draftMessage) {
    return NextResponse.json(
      { error: "subAccountId, audienceFilter, and at least one message are required" },
      { status: 400 },
    );
  }
  if (
    audienceFilter.kind !== "all" &&
    audienceFilter.kind !== "tag" &&
    audienceFilter.kind !== "pipeline_stage"
  ) {
    return NextResponse.json(
      { error: "audienceFilter.kind must be 'all', 'tag', or 'pipeline_stage'" },
      { status: 400 },
    );
  }
  const messageVariants = (payload.messageVariants ?? [draftMessage])
    .filter((m) => typeof m === "string" && m.trim())
    .slice(0, MAX_VARIANTS);

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const subAccount = subSnap.data() as SubAccountDoc;
  const gateBlock = requireRaniMastermindGate(subAccount);
  if (gateBlock) return gateBlock;
  const cfg = (subAccount.twilioConfig as TwilioConfig | undefined) ?? null;
  if (!cfg?.numberPoolEnabled) {
    return NextResponse.json(
      { error: "The Cold SMS number pool isn't enabled for this sub-account." },
      { status: 400 },
    );
  }

  const scope = await loadEffectiveTerritoryScope(access);
  const audience = await resolveSmsCampaignAudience(
    subAccountId,
    audienceFilter,
    scope.enforce ? (scope.ids ?? []) : null,
  );
  if (audience.recipients.length === 0) {
    return NextResponse.json(
      {
        error:
          "Audience is empty after pre-flight (no contacts match, or all are opted-out / missing a valid phone).",
        skipped: audience.skipped.length,
      },
      { status: 400 },
    );
  }
  if (audience.recipients.length > MAX_AUDIENCE_SIZE) {
    return NextResponse.json(
      { error: `Audience size ${audience.recipients.length} exceeds the cap of ${MAX_AUDIENCE_SIZE}.` },
      { status: 400 },
    );
  }

  // Optional buy-before-launch, same explicit-quantity-confirmation pattern
  // as the CSV importer's shortfall flow.
  let numbersBought = 0;
  const buyErrors: string[] = [];
  if (payload.buyExtraNumbers && payload.buyExtraNumbers > 0 && cfg.accountSid && cfg.authToken) {
    const qty = Math.min(50, Math.floor(payload.buyExtraNumbers));
    for (let i = 0; i < qty; i++) {
      const result = await buyNumberForState(subAccountId, cfg.accountSid, cfg.authToken, null);
      if (result.number) numbersBought++;
      else buyErrors.push(result.error ?? "unknown error");
    }
  }

  const poolSnap = await db.collection(`subAccounts/${subAccountId}/twilioNumbers`).get();
  const pool = poolSnap.docs.map((d) => d.data() as TwilioPoolNumber);
  const enabledPool = pool.filter((n) => n.enabled && !n.archivedAt);
  if (enabledPool.length === 0) {
    return NextResponse.json(
      { error: "No enabled numbers in the Cold SMS pool." },
      { status: 400 },
    );
  }

  const assignments = assignCampaignRecipients(audience.recipients, pool);
  const assignmentByContactId = new Map(assignments.map((a) => [a.contactId, a]));
  const rebalancedCount = assignments.filter((a) => a.rebalanced).length;

  const agencyId = subAccount.agencyId;
  const campaignRef = db.collection("smsCampaigns").doc();
  const code = await issueSmsCampaignCode(subAccountId);

  const duration = estimateCampaignDuration(
    audience.recipients.length,
    pool,
    cfg.defaultRatePerMinutePerNumber ?? 2,
  );
  const ownerSnapshot = await loadOwnerSnapshot(db, agencyId);

  const campaign: Omit<SmsCampaignDoc, "id"> = {
    agencyId,
    subAccountId,
    code,
    name: typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "",
    audienceFilter,
    messageVariants,
    status: "queued",
    totals: {
      audienceSize: audience.recipients.length + audience.skipped.length,
      queued: audience.recipients.length,
      sent: 0,
      skipped: audience.skipped.length,
      failed: 0,
    },
    rebalancedCount,
    numbersBoughtAtLaunch: numbersBought,
    ownerSnapshot,
    createdByUid: access.uid,
    createdAt: FieldValue.serverTimestamp() as unknown as null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
  };
  await campaignRef.set({ id: campaignRef.id, ...campaign });

  const recCol = campaignRef.collection("recipients");
  for (let i = 0; i < audience.recipients.length; i += 400) {
    const slice = audience.recipients.slice(i, i + 400);
    const batch = db.batch();
    slice.forEach((contact, sliceIdx) => {
      const idx = i + sliceIdx;
      const assignment = assignmentByContactId.get(contact.id);
      const row: Omit<SmsCampaignRecipientDoc, "id"> = {
        campaignId: campaignRef.id,
        agencyId,
        subAccountId,
        contactId: contact.id,
        toPhone: contact.phone,
        toName: contact.name,
        fromNumber: assignment?.fromNumber ?? "",
        variantIndex: idx % messageVariants.length,
        status: "queued",
        skippedReason: null,
        sid: null,
        error: null,
        queuedAt: FieldValue.serverTimestamp() as unknown as null,
        settledAt: null,
      };
      batch.set(recCol.doc(contact.id), { id: contact.id, ...row });
    });
    await batch.commit();
  }

  for (let i = 0; i < audience.skipped.length; i += 400) {
    const slice = audience.skipped.slice(i, i + 400);
    const batch = db.batch();
    for (const { contact, reason } of slice) {
      const row: Omit<SmsCampaignRecipientDoc, "id"> = {
        campaignId: campaignRef.id,
        agencyId,
        subAccountId,
        contactId: contact.id,
        toPhone: contact.phone,
        toName: contact.name,
        fromNumber: "",
        variantIndex: 0,
        status: "skipped",
        skippedReason: reason === "opted_out" ? "opted_out" : "no_phone",
        sid: null,
        error: null,
        queuedAt: FieldValue.serverTimestamp() as unknown as null,
        settledAt: FieldValue.serverTimestamp() as unknown as null,
      };
      batch.set(recCol.doc(contact.id), { id: contact.id, ...row });
    }
    await batch.commit();
  }

  // Fan out — ZERO precomputed delay per recipient. Each number's own
  // rate-limit cursor (reserveSendSlot, invoked inside enqueuePooledSms
  // from the step callback) is what actually paces sends, so there's no
  // stagger math to get right here.
  let queuedCount = 0;
  let publishFailures = 0;
  for (const contact of audience.recipients) {
    const result = await publishCallback({
      pathname: "/api/comms/sms/campaign/step",
      body: { campaignId: campaignRef.id, contactId: contact.id },
      delaySeconds: 0,
      deduplicationId: `scamp_${campaignRef.id}_${contact.id}`,
    });
    if (result) queuedCount += 1;
    else publishFailures += 1;
  }

  if (queuedCount === 0 && publishFailures > 0) {
    await campaignRef.update({
      status: "failed",
      errorMessage: "Every QStash publish failed. Check NEXT_PUBLIC_APP_URL.",
      completedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json(
      { error: "Failed to queue any recipients — campaign marked failed." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    campaignId: campaignRef.id,
    code,
    audienceSize: audience.recipients.length,
    skipped: audience.skipped.length,
    rebalancedCount,
    numbersBought,
    buyErrors,
    estimatedMinutes: duration.minutes,
    aggregateRatePerMinute: duration.aggregateRatePerMinute,
    publishFailures,
  });
}
