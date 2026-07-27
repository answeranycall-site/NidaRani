import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { WorkflowDoc } from "@/types/workflows";

/**
 * Clones every workflow belonging to the agency's designated template
 * sub-account (agencies/{id}.templateWorkflowsSubAccountId) into a
 * newly-created sub-account. Live reference, not a one-time snapshot at
 * the time this file was written — the agency owner keeps editing the
 * template sub-account's workflows in the normal Workflow Builder UI, and
 * every SUBSEQUENT new sub-account picks up whatever's there at creation
 * time. No-ops silently when the agency hasn't set a template source, or
 * the source has no workflows.
 *
 * Best-effort: runs AFTER the sub-account's own creation transaction
 * commits (needs to read the agency doc + query workflows, which can't
 * happen inside that same transaction alongside its writes — Firestore
 * requires all transactional reads before any writes). A failure here
 * can't undo the sub-account that already exists, so it's caught and
 * logged rather than surfaced to the caller.
 */
export async function cloneTemplateWorkflowsForNewSubAccount(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
}): Promise<void> {
  try {
    const db = getAdminDb();
    const agencySnap = await db.doc(`agencies/${input.agencyId}`).get();
    const sourceId = agencySnap.data()?.templateWorkflowsSubAccountId as
      | string
      | null
      | undefined;
    if (!sourceId) return;

    const sourceWfs = await db
      .collection("workflows")
      .where("subAccountId", "==", sourceId)
      .get();
    if (sourceWfs.empty) return;

    const batch = db.batch();
    for (const doc of sourceWfs.docs) {
      const w = doc.data() as Omit<WorkflowDoc, "id">;
      const newRef = db.collection("workflows").doc();
      batch.set(newRef, {
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        createdByUid: input.createdByUid,
        name: w.name,
        status: w.status,
        trigger: w.trigger,
        startNodeId: w.startNodeId,
        nodes: w.nodes,
        stats: { enrolled: 0, completed: 0 },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (err) {
    console.error(
      `[workflows/templates] clone failed for new sub-account ${input.subAccountId} (agency ${input.agencyId})`,
      err,
    );
  }
}
