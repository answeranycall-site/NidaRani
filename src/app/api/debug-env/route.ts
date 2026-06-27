import { NextResponse } from "next/server";

// Temporary debug endpoint — remove after fixing login
export const runtime = "edge";

function hasBom(s: string) {
  return s.charCodeAt(0) === 0xFEFF;
}
function stripBom(s: string) {
  return hasBom(s) ? s.slice(1) : s;
}

export async function GET() {
  const vars = [
    "FIREBASE_ADMIN_PROJECT_ID",
    "FIREBASE_ADMIN_CLIENT_EMAIL",
    "FIREBASE_ADMIN_PRIVATE_KEY",
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "COOKIE_SECRET_CURRENT",
  ] as const;

  const result: Record<string, unknown> = {};
  for (const name of vars) {
    const raw = process.env[name] ?? "";
    const bom = hasBom(raw);
    const clean = stripBom(raw);
    result[name] = {
      bom,
      preview: clean.substring(0, 20),
      length: clean.length,
    };
  }

  return NextResponse.json(result);
}
