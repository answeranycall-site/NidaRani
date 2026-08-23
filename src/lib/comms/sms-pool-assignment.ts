import "server-only";

import { stateFromAddress, stateFromE164 } from "@/lib/comms/us-area-codes";
import type { Contact } from "@/types/contacts";
import type { TwilioPoolNumber } from "@/types";

/**
 * Resolves a "from" number for CSV rows that didn't come with one — mirrors
 * the operator's prior tooling's same-state-first, round-robin fallback
 * behavior. Purely an in-memory, this-import-only round robin (a `lastIndex`
 * cursor per state, not persisted) — good enough for spreading one import's
 * assignments evenly; NOT the same mechanism as Phase 3's campaign-time
 * rebalance, which reasons about the whole pool's real-time load.
 *
 * Per the locked-in "pin only after a real send" rule, nothing this
 * resolves is final — Phase 3 can still reassign any of these contacts
 * before their first actual send.
 */
export class ImportNumberAssigner {
  private byState = new Map<string, TwilioPoolNumber[]>();
  private stateCursor = new Map<string, number>();
  private allEnabled: TwilioPoolNumber[];
  private allCursor = 0;

  constructor(pool: TwilioPoolNumber[]) {
    this.allEnabled = pool.filter((n) => n.enabled && !n.archivedAt);
    for (const n of this.allEnabled) {
      const state = stateFromE164(n.e164);
      if (!state) continue;
      const list = this.byState.get(state) ?? [];
      list.push(n);
      this.byState.set(state, list);
    }
  }

  /** Distinct states present in this import's rows that have ZERO matching
   *  pool numbers — used to prompt "buy N for state X?" before committing. */
  static missingStates(rowAddresses: (string | null)[], pool: TwilioPoolNumber[]): Map<string, number> {
    const enabled = pool.filter((n) => n.enabled && !n.archivedAt);
    const covered = new Set(
      enabled.map((n) => stateFromE164(n.e164)).filter((s): s is string => !!s),
    );
    const counts = new Map<string, number>();
    for (const addr of rowAddresses) {
      const state = addr ? stateFromAddress(addr) : null;
      if (!state || covered.has(state)) continue;
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return counts;
  }

  /** True when the pool has no enabled numbers at all — caller should
   *  refuse the whole import rather than resolve garbage assignments. */
  get isEmpty(): boolean {
    return this.allEnabled.length === 0;
  }

  /** Register a newly-bought number mid-import (after a buy-shortfall
   *  confirmation) so subsequent rows can round-robin through it too. */
  addNumber(n: TwilioPoolNumber): void {
    this.allEnabled.push(n);
    const state = stateFromE164(n.e164);
    if (state) {
      const list = this.byState.get(state) ?? [];
      list.push(n);
      this.byState.set(state, list);
    }
  }

  assign(addressText: string | null): string | null {
    if (this.allEnabled.length === 0) return null;
    const state = addressText ? stateFromAddress(addressText) : null;
    if (state) {
      const list = this.byState.get(state);
      if (list && list.length > 0) {
        const idx = (this.stateCursor.get(state) ?? 0) % list.length;
        this.stateCursor.set(state, idx + 1);
        return list[idx].e164;
      }
    }
    const idx = this.allCursor % this.allEnabled.length;
    this.allCursor++;
    return this.allEnabled[idx].e164;
  }
}

export interface CampaignAssignment {
  contactId: string;
  fromNumber: string;
  /** True when this differs from the contact's incoming `assignedFromNumber`
   *  — i.e. the rotation-balance pass actually moved them. */
  rebalanced: boolean;
}

/**
 * Equal-rotation assignment for a campaign's audience at launch time. Pure
 * round robin across every enabled pool number — no state-matching (that's
 * CSV-import-specific) — because the whole point here is spreading load
 * evenly, not geographic affinity.
 *
 * Per the locked-in "pin only after a real send" rule: a contact whose
 * `assignedFromNumberLockedAt` is already set keeps their existing number
 * untouched (rebalanced: false) — the campaign step's own send call is
 * what enforces "block, don't reroute" if that number's since been
 * disabled. Every OTHER contact (never sent to, regardless of whether they
 * came in with an import guess) gets freely round-robined, which is what
 * actually achieves equal rotation across the pool for a fresh batch.
 */
export function assignCampaignRecipients(
  recipients: Contact[],
  pool: TwilioPoolNumber[],
): CampaignAssignment[] {
  const enabled = pool.filter((n) => n.enabled && !n.archivedAt);
  if (enabled.length === 0) {
    return recipients.map((c) => ({ contactId: c.id, fromNumber: "", rebalanced: false }));
  }
  let cursor = 0;
  return recipients.map((c) => {
    const locked = !!c.assignedFromNumberLockedAt;
    if (locked && c.assignedFromNumber) {
      return { contactId: c.id, fromNumber: c.assignedFromNumber, rebalanced: false };
    }
    const assigned = enabled[cursor % enabled.length].e164;
    cursor++;
    return {
      contactId: c.id,
      fromNumber: assigned,
      rebalanced: assigned !== c.assignedFromNumber,
    };
  });
}

/**
 * Sizing check for the campaign launch confirmation: given an audience size
 * and the pool's aggregate throughput, how long will the send actually
 * take, and how many more numbers would be needed to hit a target duration?
 */
export function estimateCampaignDuration(
  audienceSize: number,
  pool: TwilioPoolNumber[],
  defaultRatePerMinute: number,
): { minutes: number; aggregateRatePerMinute: number } {
  const enabled = pool.filter((n) => n.enabled && !n.archivedAt);
  const aggregateRatePerMinute = enabled.reduce(
    (sum, n) => sum + (n.ratePerMinuteOverride ?? defaultRatePerMinute),
    0,
  );
  if (aggregateRatePerMinute <= 0) return { minutes: Infinity, aggregateRatePerMinute: 0 };
  return {
    minutes: Math.ceil(audienceSize / aggregateRatePerMinute),
    aggregateRatePerMinute,
  };
}

/** How many additional numbers (at the default rate) would close the gap
 *  to a target duration — used by the launch UI's "buy N more to finish in
 *  under X hours" suggestion. */
export function numbersNeededForTarget(
  audienceSize: number,
  targetMinutes: number,
  currentAggregateRate: number,
  defaultRatePerMinute: number,
): number {
  const requiredRate = audienceSize / Math.max(1, targetMinutes);
  const gap = requiredRate - currentAggregateRate;
  if (gap <= 0 || defaultRatePerMinute <= 0) return 0;
  return Math.ceil(gap / defaultRatePerMinute);
}
