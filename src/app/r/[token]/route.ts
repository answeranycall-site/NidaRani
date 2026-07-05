import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyReviewClickToken } from "@/lib/reviews/click-token";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

/**
 * Review-link click-through redirect. The SMS/WhatsApp review request never
 * texts the raw Google review URL — it texts this tracking link instead —
 * so we can stamp "they clicked" before bouncing them on to Google. Public,
 * unauthenticated: the HMAC token IS the credential (same model as /u/[token]
 * and /q/[token]).
 *
 * The destination isn't encoded in the token — it's read live off the
 * contact's sub-account `googleReviewConfig.reviewUrl` at click time, so an
 * operator who updates the review link later doesn't strand a
 * previously-sent text pointing at a stale destination.
 *
 * Always redirects somewhere sane even on a bad token or missing config —
 * a broken review link would otherwise look like the business's site is
 * down, which is worse than a generic fallback.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const contactId = verifyReviewClickToken(token);
  const fallback = new URL("https://www.google.com/search?q=leave+a+review");

  if (!contactId) {
    return NextResponse.redirect(fallback, { status: 302 });
  }

  const db = getAdminDb();
  const contactSnap = await db.doc(`contacts/${contactId}`).get();
  if (!contactSnap.exists) {
    return NextResponse.redirect(fallback, { status: 302 });
  }
  const contact = { id: contactSnap.id, ...(contactSnap.data() as Omit<Contact, "id">) };

  const subSnap = await db.doc(`subAccounts/${contact.subAccountId}`).get();
  const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  const reviewUrl = sub?.googleReviewConfig?.reviewUrl;
  const destination = reviewUrl ? new URL(reviewUrl) : fallback;

  // Best-effort tracking — a write failure shouldn't strand the customer
  // on a dead link.
  try {
    await db.doc(`contacts/${contactId}`).set(
      {
        reviewLinkClickedAt: FieldValue.serverTimestamp(),
        reviewLinkClickCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "review_link_clicked",
        content: "Clicked their Google review link.",
        createdBy: "review-click-redirect",
        meta: {},
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[review-click] tracking write failed", err);
  }

  return NextResponse.redirect(destination, { status: 302 });
}
