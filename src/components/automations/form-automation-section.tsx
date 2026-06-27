"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import {
  Sparkles,
  Zap,
  Plus,
  Save,
  Power,
  PowerOff,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type {
  AutomationDoc,
  InstantResponseConfig,
  MessageTemplateDoc,
} from "@/types";

interface FormAutomationSectionProps {
  formId: string;
  formName: string;
}

/**
 * Renders the "Automation" panel on the form edit page. Lets admins attach
 * the Speed-to-Lead recipe to a form, configure each of three
 * steps (lead SMS, lead email, owner notify), and toggle on/off.
 */
export function FormAutomationSection({
  formId,
  formName,
}: FormAutomationSectionProps) {
  const { user } = useAuth();
  const { agencyId, subAccountId, isAdmin, saPath } = useSubAccount();
  const [automation, setAutomation] = useState<AutomationDoc | null>(null);
  const [smsTemplates, setSmsTemplates] = useState<MessageTemplateDoc[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<MessageTemplateDoc[]>(
    [],
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !agencyId) return;
    const unsubs: Unsubscribe[] = [];

    unsubs.push(
      onSnapshot(
        query(
          collection(getFirebaseDb(), "automations"),
          where("subAccountId", "==", subAccountId),
          where("trigger.type", "==", "form_submit"),
          where("trigger.formId", "==", formId),
        ),
        (snap) => {
          const list = snap.docs.map((d) => d.data() as AutomationDoc);
          setAutomation(list[0] ?? null);
          setLoading(false);
        },
        () => setLoading(false),
      ),
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(getFirebaseDb(), "message_templates"),
          where("subAccountId", "==", subAccountId),
        ),
        (snap) => {
          const all = snap.docs.map((d) => d.data() as MessageTemplateDoc);
          setSmsTemplates(all.filter((t) => t.type === "sms"));
          setEmailTemplates(all.filter((t) => t.type === "email"));
        },
      ),
    );

    return () => {
      for (const u of unsubs) u();
    };
  }, [user, agencyId, subAccountId, formId]);

  if (loading) {
    return (
      <section className="rounded-2xl border bg-card p-5">
        <div className="h-20 animate-pulse rounded bg-muted/30" />
      </section>
    );
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Zap className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Automation</h2>
            <p className="text-xs text-muted-foreground">
              Fire a Speed-to-Lead reply when this form is submitted.
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          render={<Link href={saPath("/automations")} />}
        >
          <ExternalLink className="mr-1 h-3.5 w-3.5" />
          Manage
        </Button>
      </div>

      {!automation ? (
        <UnattachedState
          formId={formId}
          formName={formName}
          isAdmin={isAdmin}
          smsTemplates={smsTemplates}
          saPath={saPath}
          agencyId={agencyId ?? ""}
          subAccountId={subAccountId}
          createdByUid={user?.uid ?? ""}
        />
      ) : (
        <AttachedState
          automation={automation}
          isAdmin={isAdmin}
          smsTemplates={smsTemplates}
          emailTemplates={emailTemplates}
          saPath={saPath}
        />
      )}
    </section>
  );
}

interface UnattachedStateProps {
  formId: string;
  formName: string;
  isAdmin: boolean;
  smsTemplates: MessageTemplateDoc[];
  saPath: (p: string) => string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
}

function UnattachedState(props: UnattachedStateProps) {
  const [creating, setCreating] = useState(false);

  async function attach() {
    if (!props.agencyId || !props.createdByUid) return;
    setCreating(true);
    try {
      const config: InstantResponseConfig = {
        leadSms: null,
        leadEmail: null,
        ownerNotify: null,
      };
      const ref = await addDoc(collection(getFirebaseDb(), "automations"), {
        agencyId: props.agencyId,
        subAccountId: props.subAccountId,
        recipeType: "instant_response",
        name: `Instant response — ${props.formName}`,
        enabled: false,
        trigger: { type: "form_submit", formId: props.formId },
        config,
        createdByUid: props.createdByUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await updateDoc(doc(getFirebaseDb(), "automations", ref.id), {
        id: ref.id,
      });
      toast.success("Automation attached. Configure the SMS step below.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not attach.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="rounded-xl border border-dashed bg-gradient-to-br from-indigo-500/5 via-violet-500/5 to-pink-500/5 p-6 text-center">
      <Sparkles className="mx-auto mb-2 h-5 w-5 text-violet-600 dark:text-violet-400" />
      <p className="text-sm font-medium">No automation on this form yet</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
        Attach <strong>Speed-to-Lead</strong> to send an SMS the
        moment a lead submits. You&apos;ll pick a template and a delay next.
      </p>
      {!props.isAdmin ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Only sub-account admins can attach automations.
        </p>
      ) : props.smsTemplates.length === 0 ? (
        <div className="mt-4 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            You need an SMS template first.
          </p>
          <Button
            variant="outline"
            size="sm"
            render={
              <Link href={props.saPath("/automations/templates/new")} />
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Create SMS template
          </Button>
        </div>
      ) : (
        <Button
          onClick={attach}
          disabled={creating}
          size="sm"
          className="mt-4"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {creating ? "Attaching…" : "Attach automation"}
        </Button>
      )}
    </div>
  );
}

interface AttachedStateProps {
  automation: AutomationDoc;
  isAdmin: boolean;
  smsTemplates: MessageTemplateDoc[];
  emailTemplates: MessageTemplateDoc[];
  saPath: (p: string) => string;
}

function AttachedState({
  automation,
  isAdmin,
  smsTemplates,
  emailTemplates,
  saPath,
}: AttachedStateProps) {
  const [enabled, setEnabled] = useState(automation.enabled);
  const [smsTemplateId, setSmsTemplateId] = useState<string>(
    automation.config.leadSms?.templateId ?? "",
  );
  const [smsDelay, setSmsDelay] = useState<number>(
    automation.config.leadSms?.delaySeconds ?? 30,
  );
  const [emailTemplateId, setEmailTemplateId] = useState<string>(
    automation.config.leadEmail?.templateId ?? "",
  );
  const [emailDelay, setEmailDelay] = useState<number>(
    automation.config.leadEmail?.delaySeconds ?? 0,
  );
  const [ownerChannel, setOwnerChannel] = useState<"sms" | "email">(
    automation.config.ownerNotify?.channel ?? "email",
  );
  const [ownerTemplateId, setOwnerTemplateId] = useState<string>(
    automation.config.ownerNotify?.templateId ?? "",
  );
  const [ownerRecipient, setOwnerRecipient] = useState<string>(
    automation.config.ownerNotify?.recipient ?? "",
  );
  const [saving, setSaving] = useState(false);

  // Keep local form state in sync if the snapshot updates from elsewhere.
  useEffect(() => {
    setEnabled(automation.enabled);
    setSmsTemplateId(automation.config.leadSms?.templateId ?? "");
    setSmsDelay(automation.config.leadSms?.delaySeconds ?? 30);
    setEmailTemplateId(automation.config.leadEmail?.templateId ?? "");
    setEmailDelay(automation.config.leadEmail?.delaySeconds ?? 0);
    setOwnerChannel(automation.config.ownerNotify?.channel ?? "email");
    setOwnerTemplateId(automation.config.ownerNotify?.templateId ?? "");
    setOwnerRecipient(automation.config.ownerNotify?.recipient ?? "");
  }, [automation]);

  const ownerTemplates =
    ownerChannel === "email" ? emailTemplates : smsTemplates;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const newConfig: InstantResponseConfig = {
        leadSms: smsTemplateId
          ? { templateId: smsTemplateId, delaySeconds: Math.max(0, smsDelay) }
          : null,
        leadEmail: emailTemplateId
          ? {
              templateId: emailTemplateId,
              delaySeconds: Math.max(0, emailDelay),
            }
          : null,
        ownerNotify:
          ownerTemplateId && ownerRecipient.trim()
            ? {
                channel: ownerChannel,
                templateId: ownerTemplateId,
                recipient: ownerRecipient.trim(),
              }
            : null,
      };
      await updateDoc(doc(getFirebaseDb(), "automations", automation.id), {
        config: newConfig,
        updatedAt: serverTimestamp(),
      });
      toast.success("Automation saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    try {
      await updateDoc(doc(getFirebaseDb(), "automations", automation.id), {
        enabled: next,
        updatedAt: serverTimestamp(),
      });
      toast.success(next ? "Automation enabled." : "Automation disabled.");
    } catch (err) {
      setEnabled(!next);
      toast.error(err instanceof Error ? err.message : "Could not toggle.");
    }
  }

  const canEnable =
    !!smsTemplateId ||
    !!emailTemplateId ||
    (!!ownerTemplateId && !!ownerRecipient.trim());

  return (
    <form onSubmit={save} className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{automation.name}</p>
          <span
            className={
              enabled
                ? "shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                : "shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
            }
          >
            {enabled ? "Enabled" : "Paused"}
          </span>
        </div>
        <Button
          type="button"
          variant={enabled ? "outline" : "default"}
          size="sm"
          disabled={!isAdmin || (!enabled && !canEnable)}
          onClick={toggleEnabled}
        >
          {enabled ? (
            <>
              <PowerOff className="mr-1 h-3.5 w-3.5" />
              Pause
            </>
          ) : (
            <>
              <Power className="mr-1 h-3.5 w-3.5" />
              Enable
            </>
          )}
        </Button>
      </div>

      {!enabled && !canEnable && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          Configure at least one step (SMS, email, or owner notify) before
          enabling.
        </p>
      )}

      <fieldset disabled={!isAdmin} className="space-y-6">
        {/* Lead SMS step */}
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Step 1 — SMS to lead
          </Label>
          <div className="space-y-1.5">
            <Label htmlFor="sms-template">Template</Label>
            <select
              id="sms-template"
              value={smsTemplateId}
              onChange={(e) => setSmsTemplateId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">— None (skip) —</option>
              {smsTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {smsTemplates.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                No SMS templates yet.{" "}
                <Link
                  href={saPath("/automations/templates/new")}
                  className="text-primary underline"
                >
                  Create one
                </Link>
                .
              </p>
            )}
          </div>
          {smsTemplateId && (
            <div className="space-y-1.5">
              <Label htmlFor="sms-delay">Delay after submission (seconds)</Label>
              <Input
                id="sms-delay"
                type="number"
                min={0}
                max={3600}
                value={smsDelay}
                onChange={(e) => setSmsDelay(Number(e.target.value) || 0)}
                className="max-w-[160px]"
              />
            </div>
          )}
        </div>

        {/* Lead email step */}
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Step 2 — Email to lead
          </Label>
          <div className="space-y-1.5">
            <Label htmlFor="email-template">Template</Label>
            <select
              id="email-template"
              value={emailTemplateId}
              onChange={(e) => setEmailTemplateId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">— None (skip) —</option>
              {emailTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {emailTemplateId && (
            <div className="space-y-1.5">
              <Label htmlFor="email-delay">
                Delay after previous step (seconds)
              </Label>
              <Input
                id="email-delay"
                type="number"
                min={0}
                max={3600}
                value={emailDelay}
                onChange={(e) => setEmailDelay(Number(e.target.value) || 0)}
                className="max-w-[160px]"
              />
              <p className="text-[11px] text-muted-foreground">
                If both SMS and email are configured, the email fires this
                many seconds after the SMS.
              </p>
            </div>
          )}
        </div>

        {/* Owner notification step */}
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Step 3 — Notify owner
          </Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="owner-channel">Channel</Label>
              <select
                id="owner-channel"
                value={ownerChannel}
                onChange={(e) =>
                  setOwnerChannel(e.target.value as "sms" | "email")
                }
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="owner-template">Template</Label>
              <select
                id="owner-template"
                value={ownerTemplateId}
                onChange={(e) => setOwnerTemplateId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— None (skip) —</option>
                {ownerTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {ownerTemplateId && (
            <div className="space-y-1.5">
              <Label htmlFor="owner-recipient">
                {ownerChannel === "email" ? "Recipient email" : "Recipient phone (E.164)"}
              </Label>
              <Input
                id="owner-recipient"
                value={ownerRecipient}
                onChange={(e) => setOwnerRecipient(e.target.value)}
                placeholder={
                  ownerChannel === "email"
                    ? "you@agency.com"
                    : "+15555550100"
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Sent immediately after the previous step. v1 only supports a
                single static recipient.
              </p>
            </div>
          )}
        </div>
      </fieldset>

      {isAdmin && (
        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            <Save className="mr-1 h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
