import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-tenancy";

/**
 * Toggle one item on the Client Onboarding "What We're Installing"
 * checklist. Agency-owner-only by design — sub-account admins can see the
 * checklist but not mark items done; the agency owner is the one actually
 * doing the installation work across every client.
 *
 * Body: { item: string, done: boolean }
 */

interface PatchBody {
  item?: string;
  done?: boolean;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;

  const db = getAdminDb();
  const snap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const agencyId = snap.data()?.agencyId as string | undefined;
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account is missing its agencyId." },
      { status: 500 },
    );
  }

  const access = await requireAgencyOwner(request, agencyId);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const item = typeof body.item === "string" ? body.item.trim() : "";
  if (!item) {
    return NextResponse.json({ error: "item is required" }, { status: 400 });
  }
  if (typeof body.done !== "boolean") {
    return NextResponse.json({ error: "done must be a boolean" }, { status: 400 });
  }

  await db.doc(`subAccounts/${subAccountId}`).set(
    {
      onboardingChecklist: { [item]: body.done },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return NextResponse.json({ ok: true });
}
