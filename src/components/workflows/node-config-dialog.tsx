"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { NODE_LABELS } from "@/lib/workflows/catalog";
import { ConditionsEditor } from "./conditions-editor";
import type { BuilderStep } from "@/lib/workflows/builder-tree";
import type { ConditionGroup, NotifyRecipient } from "@/types/workflows";
import type { WhatsappTemplateVariable } from "@/types/whatsapp-templates";

type Cfg = Record<string, unknown>;

/** Approved WhatsApp template, loaded once and passed down for the picker. */
export interface WhatsappTemplateOption {
  id: string;
  displayName: string;
  body: string;
  variables: WhatsappTemplateVariable[];
}

/** Published Booking Page, loaded once and passed down for the
 *  `ai_propose_booking` picker. `id` is the page's slug. */
export interface BookingPageOption {
  id: string;
  name: string;
}

function deriveWait(seconds: number): { value: number; unit: number } {
  if (seconds && seconds % 86_400 === 0)
    return { value: seconds / 86_400, unit: 86_400 };
  if (seconds && seconds % 3_600 === 0)
    return { value: seconds / 3_600, unit: 3_600 };
  return { value: Math.max(1, Math.round((seconds || 0) / 60)), unit: 60 };
}

export function NodeConfigDialog({
  step,
  whatsappTemplates,
  bookingPages,
  onClose,
  onSave,
}: {
  step: BuilderStep | null;
  whatsappTemplates: WhatsappTemplateOption[];
  bookingPages: BookingPageOption[];
  onClose: () => void;
  onSave: (config: Cfg) => void;
}) {
  const [cfg, setCfg] = useState<Cfg>({});
  useEffect(() => {
    if (step) setCfg({ ...step.config });
  }, [step]);
  // Sub-account label/order overrides — same source of truth the Pipeline
  // board itself reads, so a stage renamed under Settings shows its new
  // label here too (ids never change, only the display label).
  const pipelineStages = usePipelineStages();

  if (!step) return null;
  const set = (patch: Cfg) => setCfg((c) => ({ ...c, ...patch }));
  const str = (k: string) => (cfg[k] as string) ?? "";

  const wait = deriveWait(Number(cfg.seconds ?? 86_400));
  // Legacy notify configs have no `recipient` — derive a sensible default so
  // they open showing the email they already have (else "Agency owner").
  const notifyRecipient: NotifyRecipient =
    (cfg.recipient as NotifyRecipient | undefined) ??
    (str("to").trim() ? "custom" : "owner");

  return (
    <Dialog open={!!step} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{NODE_LABELS[step.type]}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {step.type === "send_email" && (
            <>
              <Field label="Subject">
                <Input
                  value={str("subject")}
                  onChange={(e) => set({ subject: e.target.value })}
                />
              </Field>
              <Field
                label="Body"
                hint="Supports {{contact.firstName}} etc. Include {{unsubscribeLink}} for compliance."
              >
                <Textarea
                  rows={6}
                  value={str("body")}
                  onChange={(e) => set({ body: e.target.value })}
                />
              </Field>
            </>
          )}

          {step.type === "send_sms" && (
            <Field
              label="Message"
              hint="Supports merge tags like {{contact.firstName}}."
            >
              <Textarea
                rows={4}
                value={str("body")}
                onChange={(e) => set({ body: e.target.value })}
              />
            </Field>
          )}

          {step.type === "whatsapp_template" &&
            (() => {
              const tplId = str("templateId");
              const tpl = whatsappTemplates.find((t) => t.id === tplId) ?? null;
              const manualValues =
                (cfg.manualValues as Record<string, string> | undefined) ?? {};
              const mergeVars =
                tpl?.variables.filter((v) => v.source === "merge_tag") ?? [];
              const manualVars =
                tpl?.variables.filter((v) => v.source === "manual") ?? [];
              return (
                <>
                  <Field
                    label="Template"
                    hint={
                      whatsappTemplates.length === 0
                        ? "No approved WhatsApp templates yet. Create one in AI Agents → WhatsApp → Templates."
                        : "Only Meta-approved templates can be sent on WhatsApp."
                    }
                  >
                    <select
                      value={tplId}
                      onChange={(e) =>
                        set({ templateId: e.target.value, manualValues: {} })
                      }
                      className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                    >
                      <option value="">Choose a template…</option>
                      {whatsappTemplates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {tpl && (
                    <div className="bg-muted/30 text-muted-foreground rounded-md border p-2 text-xs whitespace-pre-wrap">
                      {tpl.body}
                    </div>
                  )}
                  {mergeVars.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      Auto-filled from the contact:{" "}
                      {mergeVars
                        .map((v) => `{{${v.position}}} ${v.label}`)
                        .join(", ")}
                      .
                    </p>
                  )}
                  {manualVars.map((v) => (
                    <Field
                      key={v.position}
                      label={`Variable {{${v.position}}} — ${v.label}`}
                      hint="Static text, or merge tags like {{contact.firstName}}."
                    >
                      <Input
                        value={manualValues[String(v.position)] ?? ""}
                        placeholder={v.sampleValue}
                        onChange={(e) =>
                          set({
                            manualValues: {
                              ...manualValues,
                              [v.position]: e.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                  ))}
                </>
              );
            })()}

          {step.type === "wait" && (
            <Field label="Wait for">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  className="w-24"
                  value={wait.value}
                  onChange={(e) =>
                    set({
                      seconds: Math.max(1, Number(e.target.value)) * wait.unit,
                    })
                  }
                />
                <select
                  value={wait.unit}
                  onChange={(e) =>
                    set({ seconds: wait.value * Number(e.target.value) })
                  }
                  className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                >
                  <option value={60}>minutes</option>
                  <option value={3_600}>hours</option>
                  <option value={86_400}>days</option>
                </select>
              </div>
            </Field>
          )}

          {step.type === "if_else" && (
            <Field label="Continue down “yes” when ALL of:">
              <ConditionsEditor
                value={(cfg.conditions as ConditionGroup) ?? { all: [] }}
                onChange={(g) => set({ conditions: g })}
              />
            </Field>
          )}

          {(step.type === "add_tag" || step.type === "remove_tag") && (
            <Field label="Tag">
              <Input
                value={str("tag")}
                onChange={(e) => set({ tag: e.target.value })}
              />
            </Field>
          )}

          {step.type === "move_stage" && (
            <Field label="Move contact to stage">
              <select
                value={str("stage") || "new"}
                onChange={(e) => set({ stage: e.target.value })}
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                {pipelineStages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {step.type === "move_deal_stage" && (
            <>
              <Field
                label="Move (or create) the contact's deal to"
                hint="Finds the contact's open deal and moves it here, or creates one if it has none yet."
              >
                <select
                  value={str("stageId") || "new"}
                  onChange={(e) => set({ stageId: e.target.value })}
                  className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                >
                  {pipelineStages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Deal title (only used if a new deal is created)"
                hint="Leave blank for a sensible default."
              >
                <Input
                  value={str("dealTitle")}
                  placeholder="e.g. Appointment request"
                  onChange={(e) => set({ dealTitle: e.target.value })}
                />
              </Field>
              <Field label="Deal value (only used if a new deal is created)">
                <Input
                  type="number"
                  min={0}
                  className="w-32"
                  value={Number(cfg.dealValue ?? 0)}
                  onChange={(e) => set({ dealValue: Number(e.target.value) })}
                />
              </Field>
            </>
          )}

          {step.type === "ai_propose_booking" && (
            <>
              <Field
                label="Booking page"
                hint={
                  bookingPages.length === 0
                    ? "No published booking pages yet — publish one under Calendar → Booking Pages first."
                    : "The AI offers only real, open slots from this page's availability."
                }
              >
                <select
                  value={str("bookingPageId")}
                  onChange={(e) => set({ bookingPageId: e.target.value })}
                  className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                >
                  <option value="">Choose a booking page…</option>
                  {bookingPages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex items-center gap-3">
                <Field label="Days ahead to search">
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    className="w-24"
                    value={Number(cfg.daysAhead ?? 7)}
                    onChange={(e) => set({ daysAhead: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Slots to offer">
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    className="w-24"
                    value={Number(cfg.maxSlotOptions ?? 3)}
                    onChange={(e) =>
                      set({ maxSlotOptions: Number(e.target.value) })
                    }
                  />
                </Field>
              </div>
              <Field
                label="Tone (optional)"
                hint="Extra style guidance for the AI-drafted text, e.g. “casual and upbeat”."
              >
                <Input
                  value={str("toneInstructions")}
                  onChange={(e) => set({ toneInstructions: e.target.value })}
                />
              </Field>
              <p className="text-muted-foreground text-xs">
                Every AI-drafted message from this step queues in Conversations
                for you to approve, edit, or discard before it sends — nothing
                goes out automatically. Place{" "}
                <strong className="text-foreground">
                  &ldquo;AI: Wait for booking reply&rdquo;
                </strong>{" "}
                right after this step, then{" "}
                <strong className="text-foreground">
                  &ldquo;AI: Booking outcome&rdquo;
                </strong>{" "}
                after that to branch on whether the contact actually booked.
              </p>
            </>
          )}

          {step.type === "ai_await_booking_reply" && (
            <div className="text-muted-foreground space-y-2 text-sm">
              <p>
                Place this right after &ldquo;AI: Propose appointment
                times&rdquo;. Once you approve that proposal and it sends,
                this step starts waiting for the contact to reply picking a
                slot. If the proposal is declined, or nobody approves it in
                time, this step passes straight through.
              </p>
              <p>No config of its own.</p>
            </div>
          )}

          {step.type === "ai_booking_resolver" && (
            <div className="text-muted-foreground space-y-2 text-sm">
              <p>
                Place this right after &ldquo;AI: Wait for booking
                reply&rdquo;. Branches{" "}
                <strong className="text-foreground">Yes</strong> once the
                contact&apos;s reply is matched to a slot and the appointment
                is booked, or{" "}
                <strong className="text-foreground">No</strong> if they
                declined, replied with something unreadable, or the reply
                window lapsed. Add{" "}
                <strong className="text-foreground">
                  &ldquo;Move pipeline stage&rdquo;
                </strong>{" "}
                or{" "}
                <strong className="text-foreground">
                  &ldquo;Move deal to stage&rdquo;
                </strong>{" "}
                on the Yes branch, and a human hand-off (e.g. &ldquo;Text the
                owner&rdquo;) on the No branch.
              </p>
            </div>
          )}

          {step.type === "update_field" && (
            <>
              <Field
                label="Field"
                hint="A contact field (e.g. company) or customFields.yourKey"
              >
                <Input
                  value={str("field")}
                  onChange={(e) => set({ field: e.target.value })}
                />
              </Field>
              <Field label="Value">
                <Input
                  value={str("value")}
                  onChange={(e) => set({ value: e.target.value })}
                />
              </Field>
            </>
          )}

          {step.type === "create_task" && (
            <>
              <Field label="Task title" hint="Supports merge tags.">
                <Input
                  value={str("title")}
                  onChange={(e) => set({ title: e.target.value })}
                />
              </Field>
              <Field label="Due in (days)">
                <Input
                  type="number"
                  min={0}
                  className="w-28"
                  value={Number(cfg.dueInDays ?? 1)}
                  onChange={(e) => set({ dueInDays: Number(e.target.value) })}
                />
              </Field>
            </>
          )}

          {step.type === "notify" && (
            <>
              <Field
                label="Send to"
                hint={
                  notifyRecipient === "account_contact"
                    ? "This sub-account's primary contact (Settings → Admin → Account contact). Falls back to the agency owner if none is set."
                    : notifyRecipient === "owner"
                      ? "Notifies the agency owner."
                      : undefined
                }
              >
                <select
                  value={notifyRecipient}
                  onChange={(e) =>
                    set({ recipient: e.target.value as NotifyRecipient })
                  }
                  className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                >
                  <option value="owner">Agency owner</option>
                  <option value="account_contact">Account contact</option>
                  <option value="custom">Custom email</option>
                </select>
              </Field>
              {notifyRecipient === "custom" && (
                <Field label="Email address">
                  <Input
                    value={str("to")}
                    placeholder="name@example.com"
                    onChange={(e) => set({ to: e.target.value })}
                  />
                </Field>
              )}
              <Field label="Subject">
                <Input
                  value={str("subject")}
                  onChange={(e) => set({ subject: e.target.value })}
                />
              </Field>
              <Field label="Body">
                <Textarea
                  rows={4}
                  value={str("body")}
                  onChange={(e) => set({ body: e.target.value })}
                />
              </Field>
            </>
          )}

          {step.type === "notify_owner_sms" && (
            <Field
              label="Message"
              hint="Sent as an SMS to the business owner's phone (Settings → Admin → Account contact) — not the contact/lead. Supports merge tags like {{contact.firstName}} and {{contact.phone}}, plus {{reviewRating}} / {{reviewOutcome}} when this step follows an “Ask for a rating” step (blank/generic otherwise)."
            >
              <Textarea
                rows={3}
                value={str("body")}
                onChange={(e) => set({ body: e.target.value })}
              />
            </Field>
          )}

          {step.type === "review_rating_request" && (
            <div className="text-muted-foreground space-y-2 text-sm">
              <p>
                Texts the contact &ldquo;how would you rate our service, 1-5?&rdquo;
                instead of sending the Google review link directly. A reply of
                4-5 gets the Google link; 1-3 gets a private apology message and
                a follow-up Task — the Google link is never sent for a low
                rating. This decision is always a hard rule based on the
                number, never an AI judgment call.
              </p>
              <p>
                A clean single-number reply is held ~30 seconds before it
                actually sends, in case a same-minute correction comes in
                (&ldquo;wait, 3 not 5&rdquo;). AI only gets involved for the
                genuinely unclear cases — two different numbers in one text,
                two texts back to back that disagree, or free text with no
                number at all — and always confirms its best guess with the
                contact before treating it as final.
              </p>
              <p>
                Reuses your Google review link and message templates from{" "}
                <strong className="text-foreground">
                  Settings → Messaging → Review requests
                </strong>{" "}
                — set the review link there first. Requires this sub-account&apos;s
                own dedicated Twilio number (Settings → Messaging), since reading
                the reply back means intercepting it on your own number.
              </p>
              <p>
                The moment the ask sends, the business owner (Settings →
                Admin → Account contact phone) gets an immediate text: &ldquo;A
                review request was sent to {"{name} ({phone})"}.&rdquo; — separate
                from the outcome notification below.
              </p>
              <p>
                The run pauses here until the contact replies, or for up to 7
                days. Add a{" "}
                <strong className="text-foreground">
                  &ldquo;Remind if no reply&rdquo;
                </strong>{" "}
                step right after this one to automatically notify the owner
                + send one follow-up ask if the 7 days pass with nothing back
                — it&apos;s a no-op if they already replied, so it&apos;s
                always safe to include. The next step can reference{" "}
                <code className="rounded bg-muted px-1">{"{{reviewRating}}"}</code>{" "}
                and{" "}
                <code className="rounded bg-muted px-1">{"{{reviewOutcome}}"}</code>{" "}
                (currently supported on the &ldquo;Text the owner&rdquo; step).
              </p>
            </div>
          )}

          {step.type === "review_rating_reminder" && (
            <div className="text-muted-foreground space-y-2 text-sm">
              <p>
                Place this right after &ldquo;Ask for a rating&rdquo;. If the
                contact already replied, this step does nothing and passes
                straight through. If 7 days passed with no reply, it: texts
                the owner that the window lapsed with no response, resends
                the same rating ask to the contact (this one time — it
                bypasses the normal re-ask cooldown), texts the owner that a
                reminder went out, then waits up to another 7 days for a
                reply to the reminder.
              </p>
              <p>
                No config of its own — reuses the same Settings → Messaging
                → Review requests link/templates and owner phone
                (Settings → Admin → Account contact) as the step before it.
              </p>
            </div>
          )}

          {step.type === "webhook" && (
            <Field label="POST URL">
              <Input
                value={str("url")}
                placeholder="https://…"
                onChange={(e) => set({ url: e.target.value })}
              />
            </Field>
          )}

          {step.type === "goal" && (
            <p className="text-muted-foreground text-sm">
              This step ends the workflow — nothing runs after it on this path.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(cfg);
              onClose();
            }}
          >
            Save step
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
