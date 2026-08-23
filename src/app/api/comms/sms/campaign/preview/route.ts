import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { resolveSmsCampaignAudience } from "@/lib/comms/sms-campaign-audience";
import { estimateCampaignDuration } from "@/lib/comms/sms-pool-assignment";
import type { BroadcastAudienceFilter, SubAccountDoc, TwilioConfig, TwilioPoolNumber } from "@/types";

export const dynamic = "force-dynamic";

interface Body {
  subAccountId?: string;
  audienceFilter?: BroadcastAudienceFilter;
}

/**
 * Read-only preview for the campaign launcher — resolves the audience +
 * computes the duration estimate WITHOUT creating anything, so the operator
 * sees real numbers before committing. Separate from /send (which does
 * real writes) rather than a dryRun flag on it, since send's side effects
 * (buying numbers, issuing the campaign code, batched doc creation) aren't
 * something a preview should risk triggering even partially.
 */
export async function POST(request: Request) {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const subAccountId = payload.subAccountId?.trim();
  const audienceFilter = payload.audienceFilter;
  if (!subAccountId || !audienceFilter) {
    return NextResponse.json(
      { error: "subAccountId and audienceFilter are required" },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const [subSnap, poolSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db.collection(`subAccounts/${subAccountId}/twilioNumbers`).get(),
  ]);
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const subAccount = subSnap.data() as SubAccountDoc;
  const gateBlock = requireRaniMastermindGate(subAccount);
  if (gateBlock) return gateBlock;
  const cfg = (subAccount.twilioConfig as TwilioConfig | undefined) ?? null;
  const pool = poolSnap.docs.map((d) => d.data() as TwilioPoolNumber);
  const enabledPool = pool.filter((n) => n.enabled && !n.archivedAt);

  const scope = await loadEffectiveTerritoryScope(access);
  const audience = await resolveSmsCampaignAudience(
    subAccountId,
    audienceFilter,
    scope.enforce ? (scope.ids ?? []) : null,
  );

  const duration = estimateCampaignDuration(
    audience.recipients.length,
    pool,
    cfg?.defaultRatePerMinutePerNumber ?? 2,
  );

  return NextResponse.json({
    ok: true,
    audienceSize: audience.recipients.length,
    skipped: audience.skipped.length,
    poolSize: enabledPool.length,
    poolEnabled: cfg?.numberPoolEnabled === true,
    estimatedMinutes: duration.minutes,
    aggregateRatePerMinute: duration.aggregateRatePerMinute,
  });
}
