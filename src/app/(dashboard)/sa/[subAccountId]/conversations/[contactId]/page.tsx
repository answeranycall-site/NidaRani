"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  ExternalLink,
  MessagesSquare,
  PanelRight,
  Smartphone,
  Star,
  UserPlus,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useConversationTheme } from "@/hooks/use-conversation-theme";
import { cn } from "@/lib/utils";
import { subscribeToContact } from "@/lib/firestore/contacts";
import {
  markConversationRead,
  setConversationStarred,
  subscribeToConversation,
} from "@/lib/firestore/conversations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContactForm } from "@/components/contacts/contact-form";
import { ConversationThread } from "@/components/conversations/conversation-thread";
import { ConversationComposer } from "@/components/conversations/conversation-composer";
import { ConversationAiControls } from "@/components/conversations/conversation-ai-controls";
import { ConversationDraftCard } from "@/components/conversations/conversation-draft-card";
import { ConversationContactPanel } from "@/components/conversations/conversation-contact-panel";
import type { Contact, ContactFormData } from "@/types/contacts";
import type { ConversationChannel, ConversationDoc } from "@/types/conversations";

const PANEL_KEY = "ls.convo.detailsPanel";

export default function ConversationDetailPage() {
  const params = useParams<{ contactId: string }>();
  const contactId = params.contactId;
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, subAccount, saPath } = useSubAccount();
  const router = useRouter();
  const { theme, setTheme } = useConversationTheme();
  const [contact, setContact] = useState<Contact | null>(null);
  const [conversation, setConversation] = useState<ConversationDoc | null>(null);
  const [loading, setLoading] = useState(true);
  // Right-hand contact panel — collapsed by default; remembered across
  // conversations via localStorage (desktop only; hidden under lg).
  const [panelOpen, setPanelOpen] = useState(false);
  // "Unknown person" conversations (an inbound number matched no contact)
  // offer a Create Contact dialog with the phone pre-filled instead of the
  // normal composer.
  const [convertOpen, setConvertOpen] = useState(false);
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    try {
      setPanelOpen(localStorage.getItem(PANEL_KEY) === "1");
    } catch {
      /* localStorage unavailable — keep default closed */
    }
  }, []);

  function togglePanel() {
    setPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  useEffect(() => {
    if (authLoading || !user || !contactId) return;
    setLoading(true);
    const unsubContact = subscribeToContact(contactId, (c) => {
      setContact(c);
      setLoading(false);
    });
    const unsubConv = subscribeToConversation(contactId, setConversation);
    return () => {
      unsubContact();
      unsubConv();
    };
  }, [contactId, user, authLoading]);

  // Reset the unread counter as soon as the operator opens the thread.
  useEffect(() => {
    if (contactId) void markConversationRead(contactId);
  }, [contactId]);

  const availableChannels: ConversationChannel[] = [];
  if (subAccount?.twilioConfig?.enabled) availableChannels.push("sms");
  if (
    subAccount?.twilioConfig?.whatsappFromNumber &&
    subAccount?.whatsappEnabledByAgency === true
  ) {
    availableChannels.push("whatsapp");
  }
  // BETA Meta channels — offered only when the agency gate is on, a Page is
  // connected, this contact has a Meta identity, and they've actually used the
  // channel (so we never expose a reply path the recipient can't receive).
  if (
    subAccount?.metaInboxEnabledByAgency === true &&
    subAccount?.metaConfig?.connected &&
    contact?.metaUserId
  ) {
    for (const ch of conversation?.channelsSeen ?? []) {
      if (
        (ch === "messenger" || ch === "instagram") &&
        !availableChannels.includes(ch)
      ) {
        availableChannels.push(ch);
      }
    }
  }

  // A conversation whose contactId matched no real Contact ("Unknown
  // person" — an inbound number the operator hasn't identified yet).
  // subscribeToContact() resolves to null the instant it confirms the doc
  // doesn't exist, so `!loading && !contact` reliably distinguishes this
  // from "still loading".
  const isUnknownPerson = !loading && !contact && !!conversation;
  const title = contact?.name || contact?.phone || conversation?.contactPhone || "Unknown person";

  async function handleConvert(data: ContactFormData) {
    setConverting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/conversations/${contactId}/convert-to-contact`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );
      const result = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        contactId?: string;
        error?: string;
      };
      if (!res.ok || !result.ok || !result.contactId) {
        throw new Error(result.error ?? "Couldn't create contact.");
      }
      toast.success("Contact created.");
      setConvertOpen(false);
      router.replace(saPath(`/conversations/${result.contactId}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create contact.");
    } finally {
      setConverting(false);
    }
  }

  return (
    <div className="flex h-full gap-4">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            render={<Link href={saPath("/conversations")} />}
            aria-label="Back to conversations"
            className="lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <p className="truncate text-[11px] text-muted-foreground">
              {contact?.phone ?? conversation?.contactPhone ?? ""}
              {subAccount?.twilioConfig?.enabled &&
                subAccount.twilioConfig.fromNumber && (
                  <span> · via {subAccount.twilioConfig.fromNumber}</span>
                )}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={theme === "native"}
            onClick={() =>
              setTheme(theme === "native" ? "standard" : "native")
            }
            title="Restyle the thread to each channel's native look"
            className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Smartphone className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Native</span>
            <span
              className={cn(
                "relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
                theme === "native" ? "bg-primary" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  theme === "native" ? "translate-x-3.5" : "translate-x-0.5",
                )}
              />
            </span>
          </button>
          {conversation && (
            <button
              type="button"
              title={conversation.starred ? "Unstar" : "Star"}
              onClick={() =>
                setConversationStarred(contactId, !conversation.starred)
              }
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Star
                className={cn(
                  "h-4 w-4",
                  conversation.starred && "fill-amber-400 text-amber-500",
                )}
              />
            </button>
          )}
          {contact && (
            <Button
              variant={panelOpen ? "secondary" : "outline"}
              size="sm"
              onClick={togglePanel}
              aria-pressed={panelOpen}
              className="hidden lg:inline-flex"
              title="Show contact details + activity"
            >
              <PanelRight className="mr-1 h-3.5 w-3.5" />
              Details
            </Button>
          )}
          {contact && (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={saPath(`/contacts/${contact.id}`)} />}
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              Contact
            </Button>
          )}
          {isUnknownPerson && (
            <Button size="sm" onClick={() => setConvertOpen(true)}>
              <UserPlus className="mr-1 h-3.5 w-3.5" />
              Create contact
            </Button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading conversation…</p>
        </div>
      ) : isUnknownPerson ? (
        <>
          <div className="flex items-start gap-2 border-b bg-amber-500/5 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400">
            <UserPlus className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This number isn&apos;t linked to a contact yet. Create one to
              reply and keep this conversation attached to their record.
            </span>
          </div>
          <ConversationThread contactId={contactId} theme={theme} />
        </>
      ) : !contact ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Conversation not found.</p>
        </div>
      ) : (
        <>
          {conversation && (
            <ConversationAiControls conversation={conversation} />
          )}
          <ConversationThread contactId={contactId} theme={theme} />
          {conversation?.pendingDraft && (
            <ConversationDraftCard
              contact={contact}
              draft={conversation.pendingDraft}
            />
          )}
          <ConversationComposer
            contact={contact}
            availableChannels={availableChannels}
            defaultChannel={conversation?.lastChannel ?? "sms"}
          />
        </>
      )}
      </div>

      {panelOpen && contact && (
        <aside className="hidden w-[340px] shrink-0 overflow-hidden rounded-2xl border bg-card lg:block">
          <ConversationContactPanel contact={contact} onClose={togglePanel} />
        </aside>
      )}

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create contact</DialogTitle>
          </DialogHeader>
          <ContactForm
            initial={{ phone: conversation?.contactPhone ?? "" }}
            submitLabel={converting ? "Creating…" : "Create contact"}
            onSubmit={handleConvert}
            onCancel={() => setConvertOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
