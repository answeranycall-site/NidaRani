import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import type { SmsCampaignDoc } from "@/types";

export const dynamic = "force-dynamic";

type Body = { campaignId?: string };

/**
 * Kill switch for a Cold SMS campaign. Flips to "cancelled" and skips
 * every still-queued recipient in batches. QStash messages already
 * scheduled still fire, but the step route sees the cancelled status (or
 * an already-settled row) and no-ops — no "end live call" equivalent
 * needed here, unlike voice, since an SMS send either already happened or
 * didn't.
 */
export async function POST(request: Request) {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const campaignId = payload.campaignId?.trim();
  if (!campaignId) {
    return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  }

  const db = getAdminDb();
  const campaignRef = db.collection("smsCampaigns").doc(campaignId);
  const snap = await campaignRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  const campaign = snap.data() as SmsCampaignDoc;

  const access = await requireSubAccountMember(request, campaign.subAccountId);
  if (access instanceof NextResponse) return access;

  if (campaign.status === "completed" || campaign.status === "cancelled") {
    return NextResponse.json({ ok: true, alreadyStopped: campaign.status });
  }

  const queuedSnap = await campaignRef
    .collection("recipients")
    .where("status", "==", "queued")
    .get();

  let stopped = 0;
  const docs = queuedSnap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) {
      batch.update(d.ref, {
        status: "skipped",
        skippedReason: "cancelled",
        settledAt: FieldValue.serverTimestamp(),
      });
      stopped += 1;
    }
    await batch.commit();
  }

  await campaignRef.update({
    status: "cancelled",
    completedAt: FieldValue.serverTimestamp(),
    ...(stopped > 0
      ? {
          "totals.skipped": FieldValue.increment(stopped),
          "totals.queued": FieldValue.increment(-stopped),
        }
      : {}),
  });

  return NextResponse.json({ ok: true, stopped });
}
