import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

/**
 * Disconnect the Google Business Profile connection (Google Reviews Sync).
 *
 *   DELETE /api/sub-accounts/[id]/google-business
 *
 * No tear-down on Google's side needed (there's no subscription to remove,
 * unlike Meta's page webhook) — we just clear the stored tokens. Synced
 * review docs are left in place so history isn't lost; re-connecting picks
 * up where it left off.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  await getAdminDb().doc(`subAccounts/${id}`).update({
    googleBusinessConfig: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true });
}
