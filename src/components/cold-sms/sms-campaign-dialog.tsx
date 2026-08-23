"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSubAccount } from "@/context/sub-account-context";
import type { BroadcastAudienceFilter } from "@/types";
import type { CustomFieldDef } from "@/types/custom-fields";

type FilterKind = "all" | "tag" | "pipeline_stage";

const STANDARD_VARS = ["contact.firstName", "contact.lastName", "contact.phone"];

export function SmsCampaignDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { subAccountId, saPath } = useSubAccount();

  const [name, setName] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("all");
  const [filterTag, setFilterTag] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const [message, setMessage] = useState("");
  const [variants, setVariants] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{
    audienceSize: number;
    skipped: number;
    poolSize: number;
    poolEnabled: boolean;
    estimatedMinutes: number;
    aggregateRatePerMinute: number;
  } | null>(null);
  const [buyExtra, setBuyExtra] = useState("0");
  const [sending, setSending] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setFilterKind("all");
    setFilterTag("");
    setFilterStage("");
    setMessage("");
    setVariants([]);
    setPreview(null);
    setBuyExtra("0");
    setApiError(null);
    fetch(`/api/sub-accounts/${subAccountId}/custom-fields?entity=contact`)
      .then((r) => r.json())
      .then((d: { fields?: CustomFieldDef[] }) => setCustomFields(d.fields ?? []))
      .catch(() => {});
  }, [open, subAccountId]);

  const audienceFilter: BroadcastAudienceFilter = useMemo(() => {
    if (filterKind === "tag") return { kind: "tag", tag: filterTag.trim() };
    if (filterKind === "pipeline_stage") return { kind: "pipeline_stage", stage: filterStage.trim() };
    return { kind: "all" };
  }, [filterKind, filterTag, filterStage]);

  async function runPreview() {
    setPreviewing(true);
    setApiError(null);
    try {
      const res = await fetch("/api/comms/sms/campaign/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subAccountId, audienceFilter }),
      });
      const json = (await res.json()) as typeof preview & { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json?.error ?? "Preview failed");
      setPreview(json);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function suggestVariants() {
    if (!message.trim()) {
      toast.error("Write a draft message first.");
      return;
    }
    setSuggesting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/cold-sms/suggest-variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const json = (await res.json()) as { ok?: boolean; variants?: string[]; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed to suggest variants");
      setVariants(json.variants ?? []);
      toast.success(`${json.variants?.length ?? 0} variants suggested.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to suggest variants");
    } finally {
      setSuggesting(false);
    }
  }

  function insertVariable(tag: string) {
    setMessage((prev) => `${prev}{{${tag}}}`);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    if (!message.trim()) {
      setApiError("Write a message before launching.");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/comms/sms/campaign/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subAccountId,
          audienceFilter,
          name: name.trim() || undefined,
          messageVariants: [message.trim(), ...variants],
          buyExtraNumbers: Number(buyExtra) || 0,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        campaignId?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.campaignId) {
        setApiError(data.error ?? "Couldn't start the campaign.");
        return;
      }
      toast.success("Campaign launched.");
      onOpenChange(false);
      router.push(saPath(`/cold-sms/campaigns/${data.campaignId}`));
    } catch {
      setApiError("Network error. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !sending && onOpenChange(v)}>
      <DialogContent className="max-w-lg overflow-y-auto max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Send className="h-4 w-4" />
            </span>
            New Cold SMS campaign
          </DialogTitle>
          <DialogDescription>
            Every recipient not yet locked to a number gets rotated evenly
            across your enabled pool — each number still paced at its own
            configured rate.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sc-name">Campaign name (optional)</Label>
            <Input
              id="sc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. March cold batch — TN/MO/GA"
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sc-filter-kind">Audience</Label>
            <select
              id="sc-filter-kind"
              value={filterKind}
              onChange={(e) => {
                setFilterKind(e.target.value as FilterKind);
                setPreview(null);
              }}
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All contacts in this sub-account</option>
              <option value="tag">Contacts with a specific tag</option>
              <option value="pipeline_stage">Contacts in a pipeline stage</option>
            </select>
          </div>
          {filterKind === "tag" && (
            <Input
              value={filterTag}
              onChange={(e) => {
                setFilterTag(e.target.value);
                setPreview(null);
              }}
              placeholder="Exact tag text"
            />
          )}
          {filterKind === "pipeline_stage" && (
            <Input
              value={filterStage}
              onChange={(e) => {
                setFilterStage(e.target.value);
                setPreview(null);
              }}
              placeholder="Stage id (e.g. new, contacted)"
            />
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="sc-message">Message</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={suggesting}
                onClick={suggestVariants}
                className="h-7 text-xs"
              >
                {suggesting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Suggest 5 variants
              </Button>
            </div>
            <Textarea
              id="sc-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              maxLength={480}
              placeholder="Hi {{contact.firstName}}, ..."
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Insert a variable
            </p>
            <div className="flex flex-wrap gap-1.5">
              {STANDARD_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVariable(v)}
                  className="rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-[11px] hover:bg-muted"
                >
                  {v}
                </button>
              ))}
              {customFields.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => insertVariable(`customFields.${f.key}`)}
                  className="rounded-full border bg-violet-500/10 px-2 py-0.5 font-mono text-[11px] text-violet-700 hover:bg-violet-500/20 dark:text-violet-400"
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {variants.length > 0 && (
            <div className="space-y-1.5 rounded-lg border bg-muted/20 p-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {variants.length} variants will rotate alongside your draft
              </p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {variants.map((v, i) => (
                  <li key={i} className="line-clamp-2">
                    {v}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            onClick={runPreview}
            disabled={previewing}
            className="w-full"
          >
            {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Preview audience + timing"}
          </Button>

          {preview && (
            <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Will be texted</span>
                <span className="font-mono font-semibold">{preview.audienceSize}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Skipped (opted out / no valid phone)</span>
                <span className="font-mono">{preview.skipped}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Pool size / aggregate rate</span>
                <span className="font-mono">
                  {preview.poolSize} numbers · {preview.aggregateRatePerMinute}/min
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Estimated duration</span>
                <span className="font-mono font-medium">
                  {Number.isFinite(preview.estimatedMinutes)
                    ? `~${Math.floor(preview.estimatedMinutes / 60)}h ${preview.estimatedMinutes % 60}m`
                    : "n/a — pool has no rate"}
                </span>
              </div>
              {!preview.poolEnabled && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">
                  Number pool isn&apos;t enabled for this sub-account yet.
                </p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <Label htmlFor="sc-buy-extra" className="text-xs text-muted-foreground">
                  Buy extra numbers before launch (any state):
                </Label>
                <Input
                  id="sc-buy-extra"
                  type="number"
                  min={0}
                  max={50}
                  value={buyExtra}
                  onChange={(e) => setBuyExtra(e.target.value)}
                  className="h-7 w-16 text-xs"
                />
              </div>
            </div>
          )}

          {apiError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {apiError}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending || !message.trim()}>
              {sending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Launching…
                </>
              ) : (
                <>
                  <Send className="mr-1 h-4 w-4" />
                  Launch campaign
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
