import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import type { TwilioPoolNumber } from "@/types";

/**
 * Update or remove one number in a sub-account's outbound pool. See the
 * sibling `../route.ts` for the list/add/pool-settings endpoints.
 *
 * PATCH — label / enabled / isPrimary / ratePerMinuteOverride. Setting
 *   `isPrimary: true` demotes every other number in the pool (only one
 *   primary at a time — enforced here, not left to the client).
 * DELETE — removes the number entirely. Any contact still assigned to it
 *   will BLOCK on their next send (per the locked-in "block, don't
 *   silently reroute" decision — see `lib/comms/sms-pool.ts::
 *   resolvePoolFromNumber`) until reassigned. Refuses to delete the
 *   current primary — reassign primary to another number first.
 */

interface PatchBody {
  label?: string;
  enabled?: boolean;
  isPrimary?: boolean;
  ratePerMinuteOverride?: number | null;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; numberId: string }> },
) {
  const { id: subAccountId, numberId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof body.label === "string" && body.label.trim()) {
    updates.label = body.label.trim().slice(0, 60);
  }
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
  if (
    body.ratePerMinuteOverride === null ||
    typeof body.ratePerMinuteOverride === "number"
  ) {
    updates.ratePerMinuteOverride =
      typeof body.ratePerMinuteOverride === "number"
        ? Math.max(1, Math.min(60, Math.floor(body.ratePerMinuteOverride)))
        : null;
  }

  if (body.isPrimary === true) {
    // Only one primary at a time — demote every other enabled number.
    const poolSnap = await db
      .collection(`subAccounts/${subAccountId}/twilioNumbers`)
      .get();
    const batch = db.batch();
    for (const doc of poolSnap.docs) {
      if (doc.id === numberId) continue;
      const data = doc.data() as TwilioPoolNumber;
      if (data.isPrimary) {
        batch.update(doc.ref, { isPrimary: false, updatedAt: FieldValue.serverTimestamp() });
      }
    }
    await batch.commit();
    updates.isPrimary = true;
  }

  await ref.update(updates);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; numberId: string }> },
) {
  const { id: subAccountId, numberId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/twilioNumbers/${numberId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ ok: true }); // already gone
  }
  const data = snap.data() as TwilioPoolNumber;
  if (data.isPrimary) {
    return NextResponse.json(
      {
        error:
          "This is the primary number for the pool — set a different number as primary before deleting it.",
      },
      { status: 400 },
    );
  }

  await ref.delete();
  return NextResponse.json({ ok: true });
}
