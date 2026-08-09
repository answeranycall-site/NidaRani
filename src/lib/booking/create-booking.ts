import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  computeAvailability,
  isSlotAvailable,
  type BusyEvent,
  type SlotCandidate,
} from "@/lib/booking/availability";
import {
  loadHostUpcomingCounts,
  pickLeastLoadedHost,
} from "@/lib/booking/hosts";
import { issueEventToken } from "@/lib/booking/event-token";
import { buildPaypalAmountUrl } from "@/lib/paypal/payment-link";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The transactional slot-reservation core shared by the public booking page
 * (`POST /api/booking/[saId]/[slug]/book`) and the AI Booking + Nurture SMS
 * flow (`lib/booking/ai-booking-reply.ts`). Re-verifies availability inside
 * a Firestore transaction (so a stale UI, or two channels racing on the same
 * slot, can't double-book) and writes the `events/{id}` doc.
 *
 * The two callers differ only in `source` + how the Contact is resolved:
 * the public route runs `reconcileBookingContact` (fresh, unauthenticated
 * submission — may create a new Contact by email match) BEFORE calling this;
 * the AI path already has a known Contact from the SMS conversation and
 * passes it straight through — reconciling by email again here would risk
 * minting an accidental duplicate.
 *
 * Payment-gated pages are intentionally out of scope for `source:
 * "ai_workflow"` — there's no in-SMS payment collection flow, so an AI
 * booking always writes a plain `"scheduled"` event regardless of
 * `page.payment`.
 */

export class SlotConflict extends Error {}

export interface CreateBookingInput {
  saId: string;
  agencyId: string;
  page: BookingPage;
  sub: SubAccountDoc;
  slotStart: Date;
  slotEnd: Date;
  contact: { id: string; name: string; email: string; phone: string };
  source: "booking_page" | "ai_workflow";
  /** Intake-field answers (public path only). Empty for the AI path. */
  extras?: Record<string, string>;
}

export interface CreateBookingResult {
  eventDocRef: FirebaseFirestore.DocumentReference;
  territoryId: string;
  title: string;
  rawToken: string;
  tokenHash: string;
  paymentLinkUrl: string | null;
  paymentHoldExpiresAt: Date | null;
}

function labelForField(page: BookingPage, id: string): string {
  return page.intakeFields.find((f) => f.id === id)?.label ?? id;
}

export async function createBookingTransactionally(
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const { saId, agencyId, page, sub, slotStart, slotEnd, contact, source } =
    input;
  const extras = input.extras ?? {};
  const db = getAdminDb();
  const eventsRef = db.collection("events");
  const eventDocRef = eventsRef.doc();
  const now = new Date();

  // AI-initiated bookings never go through a payment gate — see file header.
  const paymentRequired =
    source === "booking_page" && !!page.payment && !!sub.paypalConfig;

  const lookbackMs = 8 * 60 * 60_000;
  const queryFrom = new Date(slotStart.getTime() - lookbackMs);
  const queryTo = new Date(slotEnd.getTime() + 1000);

  const hosts = page.hosts ?? [];
  const teamMode = hosts.length > 0;
  const loadByHost = teamMode
    ? await loadHostUpcomingCounts(
        saId,
        hosts.map((h) => h.uid),
        now,
      )
    : new Map<string, number>();

  return db.runTransaction(async (txn) => {
    const busySnap = await txn.get(
      eventsRef
        .where("subAccountId", "==", saId)
        .where("startAt", ">=", queryFrom)
        .where("startAt", "<=", queryTo),
    );
    const occupying: BusyEvent[] = [];
    const sharedBusy: BusyEvent[] = [];
    const occupyingByHost = new Map<string, BusyEvent[]>();
    for (const d of busySnap.docs) {
      const e = d.data() as CalendarEvent;
      const s = e.status ?? "scheduled";
      if (s !== "scheduled" && s !== "awaiting_payment") continue;
      const startVal = (
        e.startAt as { toDate?: () => Date } | null
      )?.toDate?.();
      const endVal = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
      if (!(startVal instanceof Date) || !(endVal instanceof Date)) continue;
      const be: BusyEvent = { startAt: startVal, endAt: endVal };
      occupying.push(be);
      const host = e.assignedToUid ?? null;
      if (host == null) {
        sharedBusy.push(be);
      } else {
        const arr = occupyingByHost.get(host) ?? [];
        arr.push(be);
        occupyingByHost.set(host, arr);
      }
    }

    const candidate: SlotCandidate = { startAt: slotStart, endAt: slotEnd };
    let assignedToUid: string | null = null;
    let assignedToName: string | null = null;

    if (teamMode) {
      const freeHosts = hosts.filter((h) => {
        const hostBusy = occupyingByHost.get(h.uid) ?? [];
        const free = computeAvailability({
          page,
          now,
          fromInstant: new Date(slotStart.getTime() - 1),
          toInstant: new Date(slotEnd.getTime() + 1),
          busy: [...sharedBusy, ...hostBusy],
        });
        return isSlotAvailable(candidate, free);
      });
      const chosen = pickLeastLoadedHost(freeHosts, loadByHost);
      if (!chosen) throw new SlotConflict();
      assignedToUid = chosen.uid;
      assignedToName = chosen.name;
    } else {
      const free = computeAvailability({
        page,
        now,
        fromInstant: new Date(slotStart.getTime() - 1),
        toInstant: new Date(slotEnd.getTime() + 1),
        busy: occupying,
      });
      if (!isSlotAvailable(candidate, free)) {
        throw new SlotConflict();
      }
    }

    const territoryId =
      page.defaultTerritoryId && page.defaultTerritoryId.length > 0
        ? page.defaultTerritoryId
        : GLOBAL_TERRITORY_ID;

    const status = paymentRequired ? "awaiting_payment" : "scheduled";
    let paymentLinkUrl: string | null = null;
    let paymentHoldExpiresAt: Date | null = null;
    if (paymentRequired && page.payment && sub.paypalConfig) {
      paymentLinkUrl = buildPaypalAmountUrl({
        paypal: sub.paypalConfig,
        amount: page.payment.amount,
        currency: page.payment.currency,
      });
      paymentHoldExpiresAt = new Date(
        now.getTime() + page.payment.holdHours * 60 * 60_000,
      );
    }

    const title = `${page.name} — ${contact.name || contact.phone}`;
    const { token, hash } = issueEventToken(eventDocRef.id);

    const eventDoc = {
      id: eventDocRef.id,
      title,
      startAt: slotStart,
      endAt: slotEnd,
      contactId: contact.id,
      location: "",
      meetingUrl: page.meetingUrl ?? null,
      notes:
        source === "ai_workflow"
          ? "Booked by the AI Booking + Nurture SMS flow."
          : Object.entries(extras)
              .map(([k, v]) => `${labelForField(page, k)}: ${v}`)
              .join("\n"),
      agencyId,
      subAccountId: saId,
      createdByUid: source === "ai_workflow" ? "ai-booking-workflow" : "booking-page",
      territoryId,
      status,
      source,
      bookingPageSlug: page.slug,
      publicTokenHash: hash,
      paymentRequired,
      paymentAmount: page.payment?.amount ?? null,
      paymentCurrency: page.payment?.currency ?? null,
      paymentLinkUrl,
      paidAt: null,
      paidByUid: null,
      paymentHoldExpiresAt,
      assignedToUid,
      assignedToName,
      cancelledAt: null,
      cancelledByVisitor: null,
      cancelReason: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    txn.set(eventDocRef, eventDoc);

    return {
      eventDocRef,
      territoryId,
      title,
      rawToken: token,
      tokenHash: hash,
      paymentLinkUrl,
      paymentHoldExpiresAt,
    };
  });
}
