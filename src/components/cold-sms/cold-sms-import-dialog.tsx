"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSubAccount } from "@/context/sub-account-context";
import {
  parseCsv,
  guessColdSmsField,
  looksLikeFromNumberHeader,
  looksLikePhoneTypeHeader,
  guessPhoneType,
} from "@/lib/csv";

/**
 * Cold-SMS-specific CSV import — phone required (not email, unlike the
 * general contacts importer), up to 10 extra columns kept as custom
 * fields with operator-renameable labels, and a "from number" column that
 * either maps directly or gets auto-resolved (state-match, then
 * round-robin) for rows that don't have one. A dry-run preview surfaces
 * any pool shortfall before committing so the operator can buy numbers
 * first, with an explicit quantity confirmation.
 *
 * Auto-mapping is deliberately conservative — only phone/name/address/
 * website/from-number/phone-type ever auto-guess (see `guessColdSmsField`
 * in lib/csv.ts). Everything else starts unmapped so the operator picks,
 * per column, which ones become custom fields (up to 10) — never silently
 * forced into company/source/tags.
 */

type StandardField =
  | "name"
  | "phone"
  | "email"
  | "company"
  | "address"
  | "website"
  | "phoneType"
  | "source"
  | "tags"
  | "assignedFromNumber";

const STANDARD_FIELDS: { value: StandardField | ""; label: string }[] = [
  { value: "", label: "— Not mapped —" },
  { value: "name", label: "Name" },
  { value: "phone", label: "Phone (required)" },
  { value: "email", label: "Email" },
  { value: "company", label: "Company" },
  { value: "address", label: "Address (used for state-matching)" },
  { value: "website", label: "Website" },
  { value: "phoneType", label: "Phone type (Mobile / VoIP / Landline)" },
  { value: "source", label: "Source" },
  { value: "tags", label: "Tags" },
  { value: "assignedFromNumber", label: "From number (Twilio)" },
];

const MAX_CUSTOM_FIELDS = 10;
const PHONE_TYPE_OPTIONS: { value: "" | "mobile" | "voip" | "landline"; label: string }[] = [
  { value: "", label: "— Unmapped (skip) —" },
  { value: "mobile", label: "Mobile" },
  { value: "voip", label: "VoIP" },
  { value: "landline", label: "Landline" },
];

interface DryRunResult {
  totalRows: number;
  missingFromNumberCount: number;
  poolSize: number;
  poolIsEmpty: boolean;
  missingStates: Record<string, number>;
}

interface CommitResult {
  created: number;
  skipped: number;
  errors: string[];
  numbersBought: number;
  buyErrors: string[];
}

export function ColdSmsImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}) {
  const { subAccountId } = useSubAccount();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, StandardField | "">>({});
  const [customChecked, setCustomChecked] = useState<Record<string, boolean>>({});
  const [customLabels, setCustomLabels] = useState<Record<string, string>>({});
  const [phoneTypeValueMap, setPhoneTypeValueMap] = useState<
    Record<string, "" | "mobile" | "voip" | "landline">
  >({});
  const [seededPhoneTypeKey, setSeededPhoneTypeKey] = useState("");

  const [checkingPreview, setCheckingPreview] = useState(false);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [buyQuantities, setBuyQuantities] = useState<Record<string, string>>({});

  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  function reset() {
    setStep("upload");
    setFileName("");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setCustomChecked({});
    setCustomLabels({});
    setPhoneTypeValueMap({});
    setSeededPhoneTypeKey("");
    setDryRun(null);
    setBuyQuantities({});
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(file: File) {
    const text = await file.text();
    const { headers: hdrs, rows: parsed } = parseCsv(text);
    if (hdrs.length === 0 || parsed.length === 0) {
      toast.error("That file looks empty or isn't valid CSV.");
      return;
    }
    setFileName(file.name);
    setHeaders(hdrs);
    setRows(parsed);
    // Deliberately conservative — only phone/name/address/website/from-number/
    // phone-type auto-map. Everything else (county, list source, DNC flag,
    // etc.) starts unmapped so it lands straight in the operator's opt-in
    // custom-field checklist below, never silently misclassified as
    // company/source/tags.
    const nextMapping: Record<string, StandardField | ""> = {};
    for (const h of hdrs) {
      if (looksLikeFromNumberHeader(h)) {
        nextMapping[h] = "assignedFromNumber";
        continue;
      }
      if (looksLikePhoneTypeHeader(h)) {
        nextMapping[h] = "phoneType";
        continue;
      }
      nextMapping[h] = guessColdSmsField(h) ?? "";
    }
    setMapping(nextMapping);
    setStep("map");
  }

  const mappedHeaders = useMemo(
    () => new Set(Object.entries(mapping).filter(([, v]) => v).map(([h]) => h)),
    [mapping],
  );
  const unmappedHeaders = useMemo(
    () => headers.filter((h) => !mappedHeaders.has(h)),
    [headers, mappedHeaders],
  );
  const customCheckedCount = useMemo(
    () => Object.values(customChecked).filter(Boolean).length,
    [customChecked],
  );
  const hasPhoneColumn = Object.values(mapping).includes("phone");
  const phoneTypeHeader = Object.entries(mapping).find(
    ([, v]) => v === "phoneType",
  )?.[0];
  const distinctPhoneTypeValues = useMemo(() => {
    if (!phoneTypeHeader) return [];
    const seen = new Set<string>();
    for (const r of rows) {
      const v = (r[phoneTypeHeader] ?? "").trim();
      if (v) seen.add(v);
    }
    return Array.from(seen).sort();
  }, [rows, phoneTypeHeader]);

  // Seed a best-effort guess (guessPhoneType) for every distinct value seen
  // in whichever column is currently mapped to Phone type — runs whenever
  // that set changes (column re-mapped, or a fresh file lands with the
  // header auto-detected). Only fills gaps; never clobbers an operator's
  // existing correction for a value already seen. This is React's sanctioned
  // "adjust state during render" pattern (a state-tracked key, not a ref) —
  // see https://react.dev/reference/react/useState#storing-information-from-previous-renders.
  const seedKey = distinctPhoneTypeValues.join(" ");
  if (distinctPhoneTypeValues.length > 0 && seededPhoneTypeKey !== seedKey) {
    setSeededPhoneTypeKey(seedKey);
    setPhoneTypeValueMap((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const v of distinctPhoneTypeValues) {
        if (!(v in next)) {
          next[v] = guessPhoneType(v) ?? "";
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  async function runPreview() {
    if (!hasPhoneColumn) {
      toast.error("Map a column to Phone before continuing.");
      return;
    }
    setCheckingPreview(true);
    try {
      const fromHeader = Object.entries(mapping).find(
        ([, v]) => v === "assignedFromNumber",
      )?.[0];
      const addressHeader = Object.entries(mapping).find(([, v]) => v === "address")?.[0];

      const rowHasFromNumber = rows.map((r) =>
        !!(fromHeader && (r[fromHeader] ?? "").trim()),
      );
      const rowAddresses = rows.map((r) =>
        addressHeader ? (r[addressHeader] ?? "").trim() || null : null,
      );

      const res = await fetch(`/api/sub-accounts/${subAccountId}/cold-sms/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true, rowAddresses, rowHasFromNumber }),
      });
      const json = (await res.json()) as DryRunResult & { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Preview failed");
      setDryRun(json);
      setStep("preview");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setCheckingPreview(false);
    }
  }

  async function runImport() {
    setImporting(true);
    try {
      const customFieldMapping = unmappedHeaders
        .filter((h) => customChecked[h])
        .slice(0, MAX_CUSTOM_FIELDS)
        .map((h) => ({ header: h, label: (customLabels[h] || h).trim() }));

      const buyForStates: Record<string, number> = {};
      for (const [state, qtyStr] of Object.entries(buyQuantities)) {
        const qty = Number(qtyStr);
        if (Number.isFinite(qty) && qty > 0) buyForStates[state] = Math.floor(qty);
      }

      const phoneTypeValueMapToSend: Record<string, "mobile" | "voip" | "landline"> = {};
      if (phoneTypeHeader) {
        for (const [raw, bucket] of Object.entries(phoneTypeValueMap)) {
          if (bucket) phoneTypeValueMapToSend[raw] = bucket;
        }
      }

      const res = await fetch(`/api/sub-accounts/${subAccountId}/cold-sms/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows,
          standardMapping: mapping,
          customFieldMapping,
          buyForStates: Object.keys(buyForStates).length ? buyForStates : undefined,
          phoneTypeValueMap: Object.keys(phoneTypeValueMapToSend).length
            ? phoneTypeValueMapToSend
            : undefined,
        }),
      });
      const json = (await res.json()) as CommitResult & { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      setResult(json);
      setStep("done");
      if (json.created > 0) {
        toast.success(`Imported ${json.created} contact${json.created === 1 ? "" : "s"}.`);
        onImported?.();
      } else {
        toast.error("No contacts imported — check the errors.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Import cold-outreach contacts</SheetTitle>
          <SheetDescription>
            Phone-first CSV import for the Cold SMS pool. Rows without a
            &ldquo;from number&rdquo; column get one auto-assigned — matched
            to their state when possible, otherwise round-robin across the
            pool. Nothing&apos;s final until the first real text actually
            sends.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 p-4 pt-0">
          {step === "upload" && (
            <label
              htmlFor="cold-sms-csv-file"
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-muted/20 p-10 text-center transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Upload className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium">Choose a CSV file</p>
              <p className="text-xs text-muted-foreground">
                First row should be headers. Phone column is required.
              </p>
              <input
                ref={inputRef}
                id="cold-sms-csv-file"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </label>
          )}

          {step === "map" && (
            <>
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-primary" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{fileName}</p>
                    <p className="text-xs text-muted-foreground">{rows.length} rows</p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={reset}>
                  Pick another
                </Button>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Standard fields
                </Label>
                <p className="text-xs text-muted-foreground">
                  Only phone, name, address, website, and from-number/phone-type
                  columns auto-map. Everything else starts unmapped — leave it
                  that way to skip a column, or check it below to keep it as a
                  custom field.
                </p>
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-semibold">CSV column</th>
                        <th className="px-3 py-2 font-semibold">Maps to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {headers.map((h) => (
                        <tr key={h} className="border-b last:border-b-0">
                          <td className="px-3 py-2 font-medium">{h}</td>
                          <td className="px-3 py-2">
                            <select
                              value={mapping[h] ?? ""}
                              onChange={(e) =>
                                setMapping((prev) => ({
                                  ...prev,
                                  [h]: e.target.value as StandardField | "",
                                }))
                              }
                              className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
                            >
                              {STANDARD_FIELDS.map((f) => (
                                <option key={f.value} value={f.value}>
                                  {f.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!hasPhoneColumn && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Map a column to Phone before continuing.
                  </p>
                )}
              </div>

              {phoneTypeHeader && distinctPhoneTypeValues.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Phone type values ({distinctPhoneTypeValues.length} distinct)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    &ldquo;{phoneTypeHeader}&rdquo; uses these labels — confirm
                    or fix how each maps to Mobile/VoIP/Landline. Landline
                    contacts can&apos;t receive SMS.
                  </p>
                  <div className="space-y-1.5 rounded-lg border p-2">
                    {distinctPhoneTypeValues.map((v) => (
                      <div key={v} className="flex items-center gap-2">
                        <span className="w-40 shrink-0 truncate text-xs font-medium">
                          {v}
                        </span>
                        <select
                          value={phoneTypeValueMap[v] ?? ""}
                          onChange={(e) =>
                            setPhoneTypeValueMap((prev) => ({
                              ...prev,
                              [v]: e.target.value as "" | "mobile" | "voip" | "landline",
                            }))
                          }
                          className="h-7 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
                        >
                          {PHONE_TYPE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {unmappedHeaders.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Keep as custom fields ({customCheckedCount}/{MAX_CUSTOM_FIELDS})
                  </Label>
                  <div className="space-y-1.5 rounded-lg border p-2">
                    {unmappedHeaders.map((h) => (
                      <div key={h} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={!!customChecked[h]}
                          disabled={!customChecked[h] && customCheckedCount >= MAX_CUSTOM_FIELDS}
                          onChange={(e) =>
                            setCustomChecked((prev) => ({ ...prev, [h]: e.target.checked }))
                          }
                          className="h-3.5 w-3.5"
                        />
                        <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">
                          {h}
                        </span>
                        <Input
                          value={customLabels[h] ?? h}
                          onChange={(e) =>
                            setCustomLabels((prev) => ({ ...prev, [h]: e.target.value }))
                          }
                          disabled={!customChecked[h]}
                          className="h-7 flex-1 text-xs"
                          placeholder="Field label"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={runPreview} disabled={!hasPhoneColumn || checkingPreview}>
                  {checkingPreview ? "Checking…" : "Continue"}
                </Button>
              </div>
            </>
          )}

          {step === "preview" && dryRun && (
            <>
              <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
                <p className="font-medium">{dryRun.totalRows} rows ready to import</p>
                <p className="text-xs text-muted-foreground">
                  Pool: {dryRun.poolSize} enabled number{dryRun.poolSize === 1 ? "" : "s"}.{" "}
                  {dryRun.missingFromNumberCount} row
                  {dryRun.missingFromNumberCount === 1 ? "" : "s"} will get an
                  auto-assigned number.
                </p>
              </div>

              {dryRun.poolIsEmpty && (
                <p className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-700 dark:text-red-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  No enabled numbers in the pool — add or sync numbers on the
                  Cold SMS page before importing.
                </p>
              )}

              {Object.keys(dryRun.missingStates).length > 0 && (
                <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    No pool numbers for these states — rows will fall back to
                    round-robin across the whole pool unless you buy some now:
                  </p>
                  <div className="space-y-1.5">
                    {Object.entries(dryRun.missingStates).map(([state, count]) => (
                      <div key={state} className="flex items-center gap-2 text-xs">
                        <span className="w-10 shrink-0 font-mono font-medium">{state}</span>
                        <span className="flex-1 text-muted-foreground">
                          {count} row{count === 1 ? "" : "s"}
                        </span>
                        <span className="text-muted-foreground">Buy:</span>
                        <Input
                          type="number"
                          min={0}
                          max={50}
                          value={buyQuantities[state] ?? ""}
                          onChange={(e) =>
                            setBuyQuantities((prev) => ({ ...prev, [state]: e.target.value }))
                          }
                          className="h-7 w-16 text-xs"
                          placeholder="0"
                        />
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Confirming this import will buy exactly the quantities
                    entered above before assigning rows. Leave at 0 to skip
                    buying and use round-robin instead.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep("map")} disabled={importing}>
                  Back
                </Button>
                <Button onClick={runImport} disabled={importing || dryRun.poolIsEmpty}>
                  {importing ? "Importing…" : `Import ${dryRun.totalRows} rows`}
                </Button>
              </div>
            </>
          )}

          {step === "done" && result && (
            <div className="space-y-3">
              <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  Import finished · {result.created} created · {result.skipped} skipped
                </p>
                {result.numbersBought > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Bought {result.numbersBought} new number
                    {result.numbersBought === 1 ? "" : "s"}.
                  </p>
                )}
                {(result.errors.length > 0 || result.buyErrors.length > 0) && (
                  <ul className="ml-6 list-disc space-y-0.5 text-xs text-muted-foreground">
                    {result.errors.map((err, i) => (
                      <li key={`e${i}`}>{err}</li>
                    ))}
                    {result.buyErrors.map((err, i) => (
                      <li key={`b${i}`}>Buy failed — {err}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={reset}>
                  Import another
                </Button>
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
