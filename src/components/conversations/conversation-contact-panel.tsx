"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Building2,
  CircleDot,
  ExternalLink,
  Loader2,
  Mail,
  Phone,
  Plus,
  Tag,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSubAccount } from "@/context/sub-account-context";
import { SourceBadge } from "@/components/contacts/source-badge";
import { ContactDeals } from "@/components/contacts/contact-deals";
import { ContactTasks } from "@/components/contacts/contact-tasks";
import { ActivityTimeline } from "@/components/contacts/activity-timeline";
import { AddNoteInput } from "@/components/contacts/add-note-input";
import type { Contact } from "@/types/contacts";

/**
 * Right-hand contact panel for the conversation view — gives the operator
 * full context (who this is + every interaction) without leaving the thread.
 *
 * A purpose-built compact summary (no "back to contacts" link / heavy
 * Email/SMS/Delete buttons — those belong on the full profile) plus the
 * same self-contained contact components the profile page uses. Each child
 * fetches its own data from a `contactId` / `contact` and derives scope from
 * `useSubAccount()`, so this panel passes nothing but the contact. Editing
 * lives on the full profile (the "Full profile" link) to avoid duplicating
 * the territory-aware save path.
 */
export function ConversationContactPanel({
  contact,
  onClose,
}: {
  contact: Contact;
  onClose: () => void;
}) {
  const { saPath } = useSubAccount();
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [savingTag, setSavingTag] = useState(false);

  async function handleAddTag(e: FormEvent) {
    e.preventDefault();
    const tag = tagInput.trim();
    if (!tag) return;
    if ((contact.tags ?? []).includes(tag)) {
      setTagInput("");
      setAddingTag(false);
      return;
    }
    setSavingTag(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: [...(contact.tags ?? []), tag] }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        blockedTags?: string[];
      };
      if (!res.ok) throw new Error(data.error ?? "Couldn't add tag.");
      if (data.blockedTags?.length) {
        toast.error(
          `"${tag}" wasn't added — this sub-account's tag limit is full.`,
        );
      } else {
        toast.success(`Tagged "${tag}"`);
      }
      setTagInput("");
      setAddingTag(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add tag.");
    } finally {
      setSavingTag(false);
    }
  }

  function handleTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setAddingTag(false);
      setTagInput("");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <h2 className="text-sm font-semibold">Details</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            render={<Link href={saPath(`/contacts/${contact.id}`)} />}
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            Full profile
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Hide details"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Compact summary */}
        <div className="space-y-3">
          <h3 className="truncate text-base font-semibold">
            {contact.name || "Unnamed contact"}
          </h3>
          <dl className="space-y-2.5 rounded-xl border bg-background p-3 text-sm">
            {contact.email && (
              <Row icon={<Mail className="h-3.5 w-3.5" />} label="Email">
                <a
                  href={`mailto:${contact.email}`}
                  className="break-all text-foreground hover:text-primary hover:underline"
                >
                  {contact.email}
                </a>
              </Row>
            )}
            {contact.phone && (
              <Row icon={<Phone className="h-3.5 w-3.5" />} label="Phone">
                <a
                  href={`tel:${contact.phone}`}
                  className="text-foreground hover:text-primary hover:underline"
                >
                  {contact.phone}
                </a>
              </Row>
            )}
            {contact.company && (
              <Row icon={<Building2 className="h-3.5 w-3.5" />} label="Company">
                <span className="text-foreground">{contact.company}</span>
              </Row>
            )}
            <Row icon={<CircleDot className="h-3.5 w-3.5" />} label="Source">
              <SourceBadge source={contact.source} />
            </Row>
            <Row icon={<Tag className="h-3.5 w-3.5" />} label="Tags">
              <div className="flex flex-wrap items-center gap-1.5">
                {contact.tags?.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
                {!contact.tags?.length && !addingTag && (
                  <span className="text-xs text-muted-foreground">
                    No tags
                  </span>
                )}
                {!addingTag && (
                  <button
                    type="button"
                    onClick={() => setAddingTag(true)}
                    className="inline-flex items-center gap-0.5 rounded-full border border-dashed px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                  >
                    <Plus className="h-2.5 w-2.5" />
                    Add
                  </button>
                )}
              </div>
              {addingTag && (
                <form
                  onSubmit={handleAddTag}
                  className="mt-1.5 flex items-center gap-1.5"
                >
                  <Input
                    autoFocus
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    placeholder="Tag name"
                    className="h-7 text-xs"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="h-7 px-2"
                    disabled={savingTag || !tagInput.trim()}
                  >
                    {savingTag ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Add"
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5"
                    onClick={() => {
                      setAddingTag(false);
                      setTagInput("");
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </form>
              )}
            </Row>
          </dl>
        </div>

        <ContactDeals contact={contact} />
        <ContactTasks contact={contact} />

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Activity</h3>
          <AddNoteInput contactId={contact.id} />
          <ActivityTimeline contactId={contact.id} />
        </div>
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </dt>
        <dd className="min-w-0">{children}</dd>
      </div>
    </div>
  );
}
