import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

/**
 * Save the customizable Retell voice-call text-back templates (see
 * lib/comms/voice/retell-followup.ts + api/webhooks/retell/send-demo-info
 * + call-ended). Admin-only. Blank fields clear back to the shipped
 * defaults.
 */

interface PostBody {
  demoInfoTemplate?: string;
  quickHangupTemplate?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      {
        retellConfig: {
          demoInfoTemplate: body.demoInfoTemplate?.trim() || "",
          quickHangupTemplate: body.quickHangupTemplate?.trim() || "",
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return NextResponse.json({ ok: true });
}
