import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import { updateContactServerSide } from "@/lib/server/contacts-service";
import type { Condition, WorkflowDoc } from "@/types/workflows";

type Body = { contactId?: string };

const REVIEW_REQUEST_TAG = "review-request";

/**
 * True when this sub-account has an ACTIVE workflow whose trigger is
 * `contact.tag.added` filtered on tags equals "review-request" — i.e. a
 * workflow shaped like the shipped "Google Review Request [manual] & text
 * owner" template. When one exists, the manual button should enroll the
 * contact into IT (so the operator gets the same ask → reminder →
 * owner-notify sequence they built, driven by one node graph) instead of
 * firing a second, parallel send straight from this route.
 */
async function hasManualReviewTagWorkflow(subAccountId: string): Promise<boolean> {
  const snap = await getAdminDb()
    .collection("workflows")
    .where("subAccountId", "==", subAccountId)
    .where("status", "==", "active")
    .where("trigger.type", "==", "contact.tag.added")
    .get();
  return snap.docs.some((doc) => {
    const wf = doc.data() as WorkflowDoc;
    const conditions = wf.trigger.filters?.all ?? [];
    return conditions.some(
      (c: Condition) =>
        c.field === "tags" && c.op === "equals" && c.value === REVIEW_REQUEST_TAG,
    );
  });
}

/**
 * Manual "Request review" send from the contact profile. Auth-gated.
 *
 * Two paths:
 *   - If this sub-account has a "tag added -> review-request" workflow
 *     (the shipped template), tag the contact — that fires
 *     `contact.tag.added` and enrolls them into the workflow, which owns
 *     the actual send (ask -> reminder -> owner-notify), same as any
 *     other tag-triggered enrollment.
 *   - Otherwise, fall back to the direct dispatcher (today's behavior,
 *     unaffected for sub-accounts that haven't built that workflow) so
 *     the button still works with zero setup.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  if (await hasManualReviewTagWorkflow(contact.subAccountId)) {
    const tags = Array.isArray(contact.tags) ? contact.tags : [];
    if (tags.includes(REVIEW_REQUEST_TAG)) {
      // Tag's already there (a previous ask) — re-adding wouldn't fire
      // contact.tag.added again (fires only on a NEW tag), so nothing
      // would enroll. Fall back to the direct dispatcher for a re-ask.
    } else {
      const result = await updateContactServerSide({
        contactId,
        patch: { tags: [...tags, REVIEW_REQUEST_TAG] },
        mode: "live",
      });
      if (result) {
        return NextResponse.json({ ok: true, sent: true, viaWorkflow: true });
      }
    }
  }

  const result = await maybeSendReviewRequest({
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    contactId,
    trigger: "manual",
  });

  return NextResponse.json({ ok: true, sent: result.sent, reason: result.reason });
}
