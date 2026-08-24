import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { requireRaniMastermindGate } from "@/lib/auth/require-rani-mastermind";
import { bulkCreateContacts } from "@/lib/server/contacts-bulk-import";
import { ImportNumberAssigner } from "@/lib/comms/sms-pool-assignment";
import { buyNumberForState } from "@/lib/comms/twilio-purchase";
import { slugifyFieldKey } from "@/lib/custom-fields/validation";
import { isValidEmail } from "@/lib/csv";
import type {
  CustomFieldDef,
  SubAccountDoc,
  TwilioConfig,
  TwilioPoolNumber,
} from "@/types";
import type { CreateContactInput } from "@/lib/server/contacts-service";

/**
 * Cold-SMS-specific CSV import — distinct from `/api/contacts/import`
 * because that one requires an email per row (fine for occasional small
 * imports, wrong for a phone-first cold-outreach list). Two modes on one
 * route, `dryRun` flag:
 *
 *   - dryRun: parses nothing server-side (the CSV was already parsed
 *     client-side, same as the existing importer) — just reports how many
 *     rows are missing a "from" number and which states have zero pool
 *     coverage for those, so the UI can offer to buy before committing.
 *     Dry-run payload is deliberately lightweight (address + has-number
 *     flag per row only), not the full row set.
 *
 *   - commit: does the real work — optionally buys the confirmed numbers
 *     first, mints any new custom-field defs, resolves a "from" number for
 *     every row missing one (state-match → round-robin, never final per
 *     the locked-in pin rule), then batches the actual contact writes.
 */

const MAX_ROWS = 10_000;
const MAX_CUSTOM_FIELDS = 10;

interface StandardMapping {
  name?: string;
  phone?: string;
  email?: string;
  company?: string;
  address?: string;
  website?: string;
  phoneType?: string;
  source?: string;
  tags?: string;
  assignedFromNumber?: string;
}

interface CustomFieldMappingEntry {
  header: string;
  label: string;
}

interface DryRunBody {
  dryRun: true;
  rowAddresses: (string | null)[];
  rowHasFromNumber: boolean[];
}

interface CommitBody {
  dryRun?: false;
  rows: Record<string, string>[];
  standardMapping: StandardMapping;
  customFieldMapping: CustomFieldMappingEntry[];
  buyForStates?: Record<string, number>;
  /** Raw phone-type column value → canonical bucket, confirmed by the
   *  operator per distinct value seen in the mapped column (see
   *  `guessPhoneType` in lib/csv.ts for the client-side default guess).
   *  Absent/empty when no column was mapped to Phone type. */
  phoneTypeValueMap?: Record<string, "mobile" | "voip" | "landline">;
}

async function loadEnabledPool(subAccountId: string): Promise<TwilioPoolNumber[]> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/twilioNumbers`)
    .get();
  return snap.docs.map((d) => d.data() as TwilioPoolNumber);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: DryRunBody | CommitBody;
  try {
    body = (await request.json()) as DryRunBody | CommitBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const subAccount = subSnap.data() as SubAccountDoc;
  const gateBlock = requireRaniMastermindGate(subAccount);
  if (gateBlock) return gateBlock;

  if (body.dryRun) {
    const pool = await loadEnabledPool(subAccountId);
    const missingCount = body.rowHasFromNumber.filter((v) => !v).length;
    const addressesForMissing = body.rowAddresses.filter(
      (_, i) => !body.rowHasFromNumber[i],
    );
    const missingStates = ImportNumberAssigner.missingStates(addressesForMissing, pool);
    return NextResponse.json({
      ok: true,
      totalRows: body.rowHasFromNumber.length,
      missingFromNumberCount: missingCount,
      poolSize: pool.filter((n) => n.enabled && !n.archivedAt).length,
      poolIsEmpty: pool.filter((n) => n.enabled && !n.archivedAt).length === 0,
      missingStates: Object.fromEntries(missingStates),
    });
  }

  const commit = body as CommitBody;
  const rows = Array.isArray(commit.rows) ? commit.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: "No rows to import." }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `At most ${MAX_ROWS} rows per import.` },
      { status: 400 },
    );
  }
  const customFieldMapping = (commit.customFieldMapping ?? []).slice(
    0,
    MAX_CUSTOM_FIELDS,
  );

  const cfg = (subAccount.twilioConfig as TwilioConfig | undefined) ?? null;

  // 1. Buy confirmed shortfall numbers first, if any, so the assigner can
  //    round-robin through them for this same import.
  let numbersBought = 0;
  const buyErrors: string[] = [];
  const pool = await loadEnabledPool(subAccountId);
  const assigner = new ImportNumberAssigner(pool);
  if (commit.buyForStates && cfg?.accountSid && cfg.authToken) {
    for (const [state, count] of Object.entries(commit.buyForStates)) {
      for (let i = 0; i < Math.max(0, Math.min(50, count)); i++) {
        const result = await buyNumberForState(
          subAccountId,
          cfg.accountSid,
          cfg.authToken,
          state,
        );
        if (result.number) {
          assigner.addNumber(result.number);
          numbersBought++;
        } else {
          buyErrors.push(`${state}: ${result.error ?? "unknown error"}`);
        }
      }
    }
  }

  if (assigner.isEmpty) {
    return NextResponse.json(
      {
        error:
          "No enabled numbers in the Cold SMS pool — sync or add numbers first (Cold SMS page).",
      },
      { status: 400 },
    );
  }

  // 2. Mint any new custom-field defs for kept columns that don't already
  //    have one, mirroring the custom-fields create route's key/order logic.
  const existingDefsSnap = await db
    .collection(`subAccounts/${subAccountId}/customFields`)
    .where("entity", "==", "contact")
    .get();
  const existingDefs = existingDefsSnap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<CustomFieldDef, "id">) }),
  );
  const defByLabel = new Map(existingDefs.map((d) => [d.label.toLowerCase(), d]));
  const takenKeys = new Set(existingDefs.map((d) => d.key));
  let nextOrder =
    existingDefs.reduce((max, f) => Math.max(max, f.order ?? 0), -1) + 1;

  const headerToKey = new Map<string, string>();
  for (const entry of customFieldMapping) {
    const label = entry.label.trim();
    if (!label) continue;
    const existing = defByLabel.get(label.toLowerCase());
    if (existing) {
      headerToKey.set(entry.header, existing.key);
      continue;
    }
    const base = slugifyFieldKey(label) || "field";
    let key = base;
    let n = 2;
    while (takenKeys.has(key)) key = `${base}_${n++}`;
    takenKeys.add(key);
    const ref = db.collection(`subAccounts/${subAccountId}/customFields`).doc();
    await ref.set({
      entity: "contact",
      key,
      label,
      type: "text",
      options: [],
      required: false,
      order: nextOrder++,
      agencyId: subAccount.agencyId,
      subAccountId,
      createdByUid: access.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    headerToKey.set(entry.header, key);
    defByLabel.set(label.toLowerCase(), { key } as CustomFieldDef);
  }

  // 3. Build CreateContactInput per row, resolving a "from" number for any
  //    row that didn't map one.
  const mapping = commit.standardMapping ?? {};
  const inputs: CreateContactInput[] = [];
  let skipped = 0;
  const errors: string[] = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const phone = mapping.phone ? (row[mapping.phone] ?? "").trim() : "";
    if (!phone) {
      skipped++;
      if (errors.length < 5) errors.push(`Row ${idx + 2}: missing phone`);
      continue;
    }
    const address = mapping.address ? (row[mapping.address] ?? "").trim() : "";
    const providedFrom = mapping.assignedFromNumber
      ? (row[mapping.assignedFromNumber] ?? "").trim()
      : "";
    const assignedFromNumber = providedFrom || assigner.assign(address || null);

    const email = mapping.email ? (row[mapping.email] ?? "").trim() : "";
    const customFields: Record<string, string> = {};
    for (const entry of customFieldMapping) {
      const key = headerToKey.get(entry.header);
      const value = (row[entry.header] ?? "").trim();
      if (key && value) customFields[key] = value;
    }
    const phoneTypeRaw = mapping.phoneType ? (row[mapping.phoneType] ?? "").trim() : "";
    const phoneType = phoneTypeRaw
      ? commit.phoneTypeValueMap?.[phoneTypeRaw] ?? null
      : null;

    inputs.push({
      subAccountId,
      agencyId: subAccount.agencyId,
      createdByUid: access.uid,
      mode: "live",
      name: mapping.name ? (row[mapping.name] ?? "").trim() : "",
      email: email && isValidEmail(email) ? email : "",
      phone,
      company: mapping.company ? (row[mapping.company] ?? "").trim() : "",
      address,
      website: mapping.website ? (row[mapping.website] ?? "").trim() : "",
      phoneType,
      source: mapping.source ? (row[mapping.source] ?? "").trim() || "cold-sms" : "cold-sms",
      tags: mapping.tags
        ? (row[mapping.tags] ?? "")
            .split(/[,;]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      assignedFromNumber: assignedFromNumber ?? null,
      customFields,
    });
  }

  if (inputs.length === 0) {
    return NextResponse.json(
      { error: "No valid rows to import — check the phone column mapping.", errors },
      { status: 400 },
    );
  }

  const result = await bulkCreateContacts(inputs);

  return NextResponse.json({
    ok: true,
    created: result.created,
    skipped,
    errors,
    numbersBought,
    buyErrors,
  });
}
