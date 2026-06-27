import "server-only";

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  buildMetaOAuthUrl,
  metaAppConfigured,
  signMetaState,
} from "@/lib/comms/meta";
import type { SubAccountDoc } from "@/types";

/**
 * Kick off the BETA Facebook/Instagram connect flow.
 *
 *   GET /api/sub-accounts/[id]/meta/connect
 *
 * Sub-account admin only. Guards in order: agency gate
 * (`metaInboxEnabledByAgency`) must be on, and the deployment must have a Meta
 * app configured. On success redirects the admin's browser to Facebook Login;
 * any guard miss redirects back to Settings with a `?meta=…` status the
 * settings card surfaces as a toast. The callback completes the handshake.
 */

function appBase(request: Request): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
  ).replace(/\/$/, "");
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(
    `/sa/${id}/dashboard/settings`,
    appBase(request),
  );

  const snap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const sa = snap.exists ? (snap.data() as SubAccountDoc) : null;

  // Agency gate — never start a connect for a sub-account the agency hasn't
  // unlocked, even if the route is hit directly.
  if (sa?.metaInboxEnabledByAgency !== true) {
    settingsUrl.searchParams.set("meta", "gate_off");
    return NextResponse.redirect(settingsUrl);
  }

  if (!metaAppConfigured()) {
    settingsUrl.searchParams.set("meta", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const state = signMetaState(id, nonce);
  const redirectUri = `${appBase(request)}/api/sub-accounts/${id}/meta/callback`;
  return NextResponse.redirect(buildMetaOAuthUrl({ redirectUri, state }));
}
