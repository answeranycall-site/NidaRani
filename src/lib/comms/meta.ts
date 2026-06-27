import "server-only";

import crypto from "node:crypto";

/**
 * Meta (Facebook Messenger + Instagram DM) integration wrapper — the BETA
 * unified-inbox channels. Everything here is INERT unless the deployment has a
 * Meta app configured (`META_APP_ID` + `META_APP_SECRET`) AND the sub-account's
 * agency gate (`metaInboxEnabledByAgency`) is on. Mirrors the shape of
 * `lib/comms/twilio.ts`: pure helpers + Graph API calls, no Firestore writes.
 *
 * Graph API version is pinned so a Meta-side default bump can't silently change
 * behaviour. Token exchange / page subscription only run during the OAuth
 * connect flow; the inbound webhook only needs signature verification.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * OAuth scopes requested when an admin connects a Page. `pages_messaging` +
 * `instagram_manage_messages` are App-Review-gated by Meta — until the app
 * passes review these are only grantable to the app's own admins/testers, which
 * is exactly the beta-tester model.
 */
const OAUTH_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_manage_messages",
  "business_management",
].join(",");

/** The webhook fields we subscribe each connected Page to. */
const SUBSCRIBED_FIELDS = "messages,messaging_postbacks,message_reactions";

/** True when the deployment has Meta app credentials. Gate every connect/send on this. */
export function metaAppConfigured(): boolean {
  return !!process.env.META_APP_ID && !!process.env.META_APP_SECRET;
}

/** The verify token Meta echoes during the webhook GET handshake. */
export function metaWebhookVerifyToken(): string | null {
  return process.env.META_WEBHOOK_VERIFY_TOKEN || null;
}

/** Build the Facebook Login dialog URL the admin is redirected to. */
export function buildMetaOAuthUrl(opts: {
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? "",
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: OAUTH_SCOPES,
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// CSRF state — HMAC-signed with the existing AUTOMATIONS_TOKEN_SECRET so the
// callback can trust `state` came from our connect route (and names the right
// sub-account) without persisting anything.
// ---------------------------------------------------------------------------

function stateSecret(): string {
  return process.env.AUTOMATIONS_TOKEN_SECRET ?? "";
}

export function signMetaState(subAccountId: string, nonce: string): string {
  const payload = `${subAccountId}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", stateSecret())
    .update(`metastate:${payload}`)
    .digest("hex");
  return `${payload}.${sig}`;
}

export function verifyMetaState(
  state: string,
): { subAccountId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [subAccountId, nonce, sig] = parts;
  const expected = crypto
    .createHmac("sha256", stateSecret())
    .update(`metastate:${subAccountId}.${nonce}`)
    .digest("hex");
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  return { subAccountId };
}

/**
 * Verify the `X-Hub-Signature-256` header Meta sends on every webhook POST.
 * HMAC-SHA256 of the RAW body keyed by the app secret, formatted `sha256=…`.
 * Returns false (reject) when no app secret is configured.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
): boolean {
  const secret = process.env.META_APP_SECRET ?? "";
  if (!header || !secret) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Graph API calls (connect flow + inbound enrichment)
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
}

/** Exchange the OAuth `code` for a user access token. */
export async function exchangeCodeForUserToken(
  code: string,
  redirectUri: string,
): Promise<string> {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? "",
    client_secret: process.env.META_APP_SECRET ?? "",
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch(`${GRAPH}/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Meta token exchange failed (${res.status})`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error("Meta token exchange: no token");
  return data.access_token;
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  instagramBusinessAccountId: string | null;
  instagramUsername: string | null;
}

interface PagesResponse {
  data?: Array<{
    id: string;
    name?: string;
    access_token?: string;
    instagram_business_account?: { id?: string; username?: string };
  }>;
}

/** List the Pages the connecting user manages, with any linked IG account. */
export async function listMetaPages(userToken: string): Promise<MetaPage[]> {
  const fields =
    "id,name,access_token,instagram_business_account{id,username}";
  const res = await fetch(
    `${GRAPH}/me/accounts?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(userToken)}`,
  );
  if (!res.ok) {
    throw new Error(`Meta pages fetch failed (${res.status})`);
  }
  const data = (await res.json()) as PagesResponse;
  return (data.data ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? "Facebook Page",
    accessToken: p.access_token ?? "",
    instagramBusinessAccountId: p.instagram_business_account?.id ?? null,
    instagramUsername: p.instagram_business_account?.username ?? null,
  }));
}

/** Subscribe a Page to our app's webhook so we receive its message events. */
export async function subscribePageToWebhook(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const params = new URLSearchParams({
    subscribed_fields: SUBSCRIBED_FIELDS,
    access_token: pageAccessToken,
  });
  const res = await fetch(
    `${GRAPH}/${pageId}/subscribed_apps?${params.toString()}`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(`Meta page subscribe failed (${res.status})`);
  }
}

/** Best-effort unsubscribe when a sub-account disconnects. */
export async function unsubscribePageFromWebhook(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const params = new URLSearchParams({ access_token: pageAccessToken });
  const res = await fetch(
    `${GRAPH}/${pageId}/subscribed_apps?${params.toString()}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(`Meta page unsubscribe failed (${res.status})`);
  }
}

interface SendResponse {
  message_id?: string;
  error?: { message?: string; code?: number };
}

/**
 * Send an outbound text message on Messenger or Instagram.
 *
 * Both go through the same Graph `…/messages` endpoint authed with the Page
 * token; only the sending node differs — the Page id for Messenger, the linked
 * IG business-account id for Instagram. `messaging_type: "RESPONSE"` marks this
 * as a reply within the user's messaging window (the standard, tag-free case).
 * Returns the Meta message id. Throws with Meta's error text on failure.
 */
export async function sendMetaMessage(opts: {
  channel: "messenger" | "instagram";
  fromNodeId: string;
  recipientId: string;
  text: string;
  pageAccessToken: string;
}): Promise<string> {
  const res = await fetch(
    `${GRAPH}/${opts.fromNodeId}/messages?access_token=${encodeURIComponent(opts.pageAccessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: opts.recipientId },
        message: { text: opts.text },
      }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as SendResponse;
  if (!res.ok || data.error || !data.message_id) {
    throw new Error(
      data.error?.message ?? `Meta send failed (${res.status})`,
    );
  }
  return data.message_id;
}

interface ProfileResponse {
  name?: string;
  username?: string;
}

/**
 * Look up a messaging user's display name by their page-scoped id, using the
 * Page token. Best-effort — returns null on any failure so inbound handling
 * never blocks on it.
 */
export async function getMetaUserName(
  userId: string,
  pageAccessToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${GRAPH}/${userId}?fields=name,username&access_token=${encodeURIComponent(pageAccessToken)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as ProfileResponse;
    return data.name || data.username || null;
  } catch {
    return null;
  }
}
