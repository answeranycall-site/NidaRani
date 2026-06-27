import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

/**
 * Reset the website doc to draft state. Used by the "Rebuild" button on
 * the ready banner — clears gitpageJobId / liveUrl / status so the user
 * can edit the form and submit a new build.
 *
 * Does NOT call gitpage to tear down the previously-published site — that
 * stays live until the operator deletes the GitHub repo manually. Each
 * rebuild creates a brand-new repo on gitpage's side.
 *
 * Preserves the config so the user starts from their last submission.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/main`);
  const snap = await docRef.get();
  if (!snap.exists) {
    return NextResponse.json(
      { error: "No website to reset." },
      { status: 404 },
    );
  }

  await docRef.update({
    status: "draft",
    gitpageJobId: null,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true });
}
