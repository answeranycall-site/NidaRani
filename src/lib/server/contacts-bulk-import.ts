import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { serializeContactForApi } from "@/lib/api/serializers/contacts";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { CreateContactInput } from "@/lib/server/contacts-service";

/**
 * Batched contact creation for large imports (the Cold SMS CSV flow, up to
 * ~8,000 rows). `createContactServerSide` does one Firestore round-trip per
 * contact — fine for the handful-of-rows dashboard/API paths it was built
 * for, but a real timeout risk at this scale. This chunks writes into
 * `db.batch()` calls (mirrors the batching shell in `lib/import/bulk-write.
 * ts` — NOT its upsert-by-external_id logic, which doesn't apply here).
 *
 * `contact.created` webhook + workflow-trigger dispatch stay per-row and
 * fire-and-forget, exactly like the single-row path — just deferred until
 * after each chunk's batch commits, so a webhook never fires for a write
 * that turned out to fail.
 */

const BATCH_OP_LIMIT = 400;

export interface BulkCreateContactsResult {
  created: number;
  ids: string[];
}

export async function bulkCreateContacts(
  rows: CreateContactInput[],
): Promise<BulkCreateContactsResult> {
  const db = getAdminDb();
  const ids: string[] = [];

  let batch = db.batch();
  let ops = 0;
  let pendingRefs: { ref: FirebaseFirestore.DocumentReference; input: CreateContactInput }[] = [];
  const allDispatches: { ref: FirebaseFirestore.DocumentReference; input: CreateContactInput }[] = [];

  async function flush() {
    if (ops === 0) return;
    await batch.commit();
    allDispatches.push(...pendingRefs);
    batch = db.batch();
    ops = 0;
    pendingRefs = [];
  }

  for (const input of rows) {
    const ref = db.collection("contacts").doc();
    const doc = {
      name: input.name,
      email: input.email,
      phone: input.phone,
      company: input.company,
      address: input.address,
      source: input.source,
      tags: input.tags,
      pipelineStage: input.pipelineStage ?? null,
      attribution: input.attribution ?? null,
      assignedFromNumber: input.assignedFromNumber ?? null,
      customFields: input.customFields ?? null,
      emailOptedOut: false,
      smsOptedOut: false,
      countryCode: null,
      country: null,
      city: null,
      lat: null,
      lng: null,
      territoryId: input.territoryId ?? GLOBAL_TERRITORY_ID,
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: input.createdByUid,
      mode: input.mode,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    batch.set(ref, doc);
    ops++;
    pendingRefs.push({ ref, input });
    ids.push(ref.id);
    if (ops >= BATCH_OP_LIMIT) await flush();
  }
  await flush();

  // Fire-and-forget dispatch, same shape as createContactServerSide's
  // single-row path — never awaited by the caller, never blocks the import
  // response.
  const now = new Date();
  for (const { ref, input } of allDispatches) {
    const contact = serializeContactForApi(
      ref.id,
      {
        name: input.name,
        email: input.email,
        phone: input.phone,
        company: input.company,
        address: input.address,
        source: input.source,
        tags: input.tags,
        pipelineStage: input.pipelineStage ?? null,
        attribution: input.attribution ?? null,
        assignedFromNumber: input.assignedFromNumber ?? null,
        customFields: input.customFields ?? null,
        emailOptedOut: false,
        smsOptedOut: false,
        countryCode: null,
        country: null,
        city: null,
        lat: null,
        lng: null,
        territoryId: input.territoryId ?? GLOBAL_TERRITORY_ID,
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        createdByUid: input.createdByUid,
        mode: input.mode,
        createdAt: now,
        updatedAt: now,
      },
      input.mode,
    );
    void emitWebhookEvent({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      mode: input.mode,
      type: "contact.created",
      payload: { contact },
    });
    if (input.mode === "live") {
      void fireWorkflowTrigger({
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        type: "contact.created",
        contactId: ref.id,
      });
    }
  }

  return { created: ids.length, ids };
}
