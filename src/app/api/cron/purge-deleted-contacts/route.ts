import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { DELETED_CONTACT_RETENTION_DAYS } from "@/lib/contacts/retention";

/**
 * Daily sweep that permanently removes contacts soft-deleted (see
 * Contact.deletedAt, DELETE /api/contacts/[id]) more than
 * DELETED_CONTACT_RETENTION_DAYS ago. Mirrors cron/api-cleanup's shape:
 * bounded batch + self-scheduled continuation if the cap is hit.
 *
 * contact.deleted already fired at soft-delete time (see
 * emitContactDeleted in the DELETE route) — this sweep does NOT re-fire it,
 * it's just the deferred physical cleanup.
 */

const BATCH_LIMIT = 200;
const CONTINUATION_DELAY_SEC = 60;

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const db = getAdminDb();
  const cutoff = new Date(
    Date.now() - DELETED_CONTACT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  const snap = await db
    .collection("contacts")
    .where("deletedAt", "<", cutoff)
    .limit(BATCH_LIMIT)
    .get();

  let purged = 0;
  const errors: string[] = [];
  for (const doc of snap.docs) {
    try {
      await db.recursiveDelete(doc.ref);
      await db.doc(`conversations/${doc.id}`).delete().catch(() => {});
      purged += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[cron/purge-deleted-contacts] failed for ${doc.id}: ${msg}`);
      errors.push(`${doc.id}: ${msg}`);
    }
  }

  const hitCap = snap.size >= BATCH_LIMIT;
  if (hitCap) {
    await publishCallback({
      pathname: "/api/cron/purge-deleted-contacts",
      body: {},
      delaySeconds: CONTINUATION_DELAY_SEC,
      deduplicationId: `purge-deleted-contacts_continuation_${Math.floor(Date.now() / 1000 / 60)}`,
    });
  }

  return NextResponse.json({
    ok: true,
    purged,
    errors,
    continuationScheduled: hitCap,
  });
}
