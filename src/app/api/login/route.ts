import { setAuthCookies } from "next-firebase-auth-edge/next/cookies";
import { NextRequest, NextResponse } from "next/server";

// Node.js runtime avoids the Edge-specific private-key parsing issues
// that break next-firebase-auth-edge's loginPath handler in Edge Middleware.
export const runtime = "nodejs";

// Strip UTF-8 BOM (﻿) that can be silently prepended by some tooling
// when env vars are piped to the Vercel CLI on Windows.
function stripBom(s: string): string {
  return s.startsWith("﻿") ? s.slice(1) : s;
}

const AUTH_OPTIONS = {
  apiKey: stripBom(process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? ""),
  cookieName: "__session",
  cookieSignatureKeys: [
    stripBom(process.env.COOKIE_SECRET_CURRENT ?? ""),
    stripBom(process.env.COOKIE_SECRET_PREVIOUS ?? ""),
  ],
  cookieSerializeOptions: {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 12 * 60 * 60 * 24,
  },
  serviceAccount: {
    projectId: stripBom(process.env.FIREBASE_ADMIN_PROJECT_ID ?? ""),
    clientEmail: stripBom(process.env.FIREBASE_ADMIN_CLIENT_EMAIL ?? ""),
    privateKey: stripBom(
      (process.env.FIREBASE_ADMIN_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    ),
  },
};

export async function GET(request: NextRequest) {
  try {
    return await setAuthCookies(request.headers, AUTH_OPTIONS);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    console.error("[api/login] setAuthCookies error:", message);
    return new NextResponse(JSON.stringify({ error: message }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
}
