import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

/**
 * PATCH /api/sub-accounts/[id]/old-leads-file
 *
 * Records the sub-account's uploaded "old leads" file (Dashboard, Dead
 * Lead Reactivation) — a durable reference, not a data import. The file
 * itself is already uploaded client-side to Firebase Storage
 * (old-leads/{subAccountId}/{fileName}); this just stores the resulting
 * download URL + original filename so the operator can re-download it
 * later. Body: { url: string; fileName: string } | { url: null }.
 *
 * Auth: sub-account admin OR agency owner (via requireSubAccountAdmin).
 */

const URL_RE = /^https?:\/\/.+/i;

interface PatchBody {
  url?: string | null;
  fileName?: string;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.url === null) {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}`)
      .set(
        { oldLeadsFile: null, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    return NextResponse.json({ ok: true, oldLeadsFile: null });
  }

  const url = (body.url ?? "").trim();
  const fileName = (body.fileName ?? "").trim().slice(0, 300);
  if (!URL_RE.test(url) || !fileName) {
    return NextResponse.json(
      { error: "url (http/https) and fileName are required." },
      { status: 400 },
    );
  }

  const oldLeadsFile = {
    url,
    fileName,
    uploadedAt: FieldValue.serverTimestamp(),
  };
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set({ oldLeadsFile, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return NextResponse.json({ ok: true, oldLeadsFile });
}
