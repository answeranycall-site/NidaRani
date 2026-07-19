import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

/**
 * Best-effort logo discovery from a business's public website — powers the
 * Client Onboarding page's "fetch from website" button so the operator
 * doesn't have to go hunting for a hosted logo URL themselves. Fetches the
 * page HTML server-side (the browser can't due to CORS), looks for the
 * highest-quality candidate in order (og:image > apple-touch-icon > icon),
 * and falls back to /favicon.ico. Returns a candidate URL for the operator
 * to review/apply — this route never writes anything itself.
 */

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 500_000;

interface PostBody {
  websiteUrl?: string;
}

function normaliseWebsiteUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u;
  } catch {
    return null;
  }
}

function extractAttr(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  return match?.[1]?.trim() || null;
}

function resolveUrl(candidate: string, base: URL): string | null {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
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

  const url = normaliseWebsiteUrl(body.websiteUrl ?? "");
  if (!url) {
    return NextResponse.json(
      { error: "Enter a valid website URL." },
      { status: 400 },
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AnswerAnyCallBot/1.0)" },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Site returned ${res.status}.` },
        { status: 502 },
      );
    }
    const reader = res.body?.getReader();
    if (!reader) {
      html = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }
      reader.cancel().catch(() => {});
      html = Buffer.concat(chunks).toString("utf8");
    }
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error && err.name === "AbortError"
            ? "Timed out reaching that site."
            : "Couldn't reach that site.",
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }

  // Only look inside <head> — favicons/OG tags never appear in <body>, and
  // this keeps the regex scan cheap on a large page.
  const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? html;

  const ogImage = extractAttr(
    head,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  );
  const appleTouchIcon = extractAttr(
    head,
    /<link[^>]+rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i,
  );
  const icon = extractAttr(
    head,
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i,
  );

  const candidate = ogImage || appleTouchIcon || icon;
  const resolved = candidate ? resolveUrl(candidate, url) : null;
  const logoUrl = resolved || `${url.origin}/favicon.ico`;

  return NextResponse.json({ logoUrl });
}
