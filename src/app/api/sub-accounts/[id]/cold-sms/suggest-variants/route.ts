import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

interface Body {
  message: string;
}

/**
 * On-demand (button click, not live-as-you-type per the operator's own
 * call) generation of spam-pattern-avoidance variants for a cold-SMS
 * campaign message — same rationale as rotating the sending number: many
 * numbers all sending byte-identical text is its own detection signal.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const gateBlock = requireRaniMastermindGate(subSnap.data() as SubAccountDoc | undefined);
  if (gateBlock) return gateBlock;

  if (!aiIsConfigured()) {
    return NextResponse.json(
      { error: "OPENROUTER_API_KEY is not set on this deployment." },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  try {
    const completion = await callAi({
      temperature: 0.9,
      maxTokens: 600,
      messages: [
        {
          role: "system",
          content:
            "You write SMS cold-outreach message variants. Given one draft SMS, produce exactly 5 alternative phrasings that keep the same intent, tone, and any {{merge tags}} verbatim (never alter or remove a {{...}} tag), but vary the wording enough to avoid identical-text spam pattern detection across many numbers. Keep each variant under 320 characters, no markdown, no emoji unless the original used one. Respond with ONLY the 5 variants, one per line, no numbering, no extra commentary.",
        },
        { role: "user", content: message },
      ],
    });
    const variants = completion.text
      .split("\n")
      .map((line) => line.replace(/^\d+[.)]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 5);

    return NextResponse.json({ ok: true, variants });
  } catch (err) {
    const message2 = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: message2 }, { status: 502 });
  }
}
