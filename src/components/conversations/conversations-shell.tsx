"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Search, Star, Tag as TagIcon, Trash2, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToConversations } from "@/lib/firestore/conversations";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ConversationList } from "@/components/conversations/conversation-list";
import type { ConversationDoc } from "@/types/conversations";

type Filter = "all" | "unread" | "starred";

/**
 * Master-detail shell for the Conversations tab. Lives in layout.tsx so it
 * persists across navigation between `/conversations` (no selection) and
 * `/conversations/[contactId]` (thread open) — only the right-hand pane
 * ({children}) swaps, matching a normal inbox app instead of a full page
 * reload per conversation.
 *
 * Mobile: shows the list OR the open thread, never both — detected by
 * comparing the current path against the bare conversations base path.
 */
export function ConversationsShell({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, saPath } = useSubAccount();
  const pathname = usePathname();
  const [conversations, setConversations] = useState<ConversationDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  // contactId -> tags[], joined client-side (not denormalized onto the
  // conversation doc) so a tag added/removed from the contact profile,
  // a workflow's add_tag/remove_tag node, etc. is always reflected here
  // without having to keep every tag-mutation call site in sync with a
  // copy on the conversation doc.
  const [contactTags, setContactTags] = useState<Map<string, string[]>>(new Map());
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const router = useRouter();

  // Bulk selection — checkboxes on the list, an action bar with delete +
  // add-tag once anything's checked.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState("");
  const [taggingBulk, setTaggingBulk] = useState(false);

  function toggleSelect(contactId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function handleBulkDelete() {
    setDeleting(true);
    const ids = [...selected];
    const results = await Promise.allSettled(
      ids.map((id) => fetch(`/api/contacts/${id}`, { method: "DELETE" })),
    );
    let succeeded = 0;
    let blocked = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.ok) succeeded++;
      else blocked++;
    }
    if (succeeded > 0) {
      toast.success(
        `Deleted ${succeeded} conversation${succeeded === 1 ? "" : "s"}.`,
      );
    }
    if (blocked > 0) {
      toast.error(
        `${blocked} couldn't be deleted — still linked to other records (deals, tasks, etc).`,
      );
    }
    // If the thread currently open just got deleted, back out to the list.
    const basePathNow = saPath("/conversations");
    const openContactId =
      pathname !== basePathNow ? pathname.slice(basePathNow.length + 1) : null;
    if (openContactId && ids.includes(openContactId)) {
      router.replace(basePathNow);
    }
    setDeleting(false);
    setConfirmDeleteOpen(false);
    clearSelection();
  }

  async function handleBulkAddTag(e: FormEvent) {
    e.preventDefault();
    const tag = bulkTagInput.trim();
    if (!tag) return;
    setTaggingBulk(true);
    const ids = [...selected];
    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/contacts/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tags: [...(contactTags.get(id) ?? []), tag],
          }),
        }),
      ),
    );
    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok,
    ).length;
    if (succeeded > 0) {
      toast.success(
        `Tagged ${succeeded} contact${succeeded === 1 ? "" : "s"} "${tag}".`,
      );
    }
    if (succeeded < ids.length) {
      toast.error(`${ids.length - succeeded} couldn't be tagged.`);
    }
    setTaggingBulk(false);
    setBulkTagOpen(false);
    setBulkTagInput("");
    clearSelection();
  }

  useEffect(() => {
    if (authLoading || !user || !subAccountId) return;
    setLoading(true);
    const unsub = subscribeToConversations(subAccountId, (list) => {
      setConversations(list);
      setLoading(false);
    });
    return () => unsub();
  }, [user, subAccountId, authLoading]);

  // Switching sub-accounts invalidates any in-flight selection.
  useEffect(() => {
    setSelected(new Set());
  }, [subAccountId]);

  useEffect(() => {
    if (authLoading || !user || !subAccountId || !agencyId) return;
    const unsub = subscribeToContacts({ subAccountId, agencyId }, (contacts) => {
      const map = new Map<string, string[]>();
      for (const c of contacts) map.set(c.id, c.tags ?? []);
      setContactTags(map);
    });
    return () => unsub();
  }, [user, subAccountId, agencyId, authLoading]);

  const unreadTotal = conversations.filter((c) => (c.unreadCount ?? 0) > 0).length;
  const starredTotal = conversations.filter((c) => c.starred).length;

  // Tags to offer as filter pills — only tags actually present on a contact
  // with a conversation, so every pill is guaranteed at least one match.
  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of conversations) {
      for (const tag of contactTags.get(c.contactId) ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [conversations, contactTags]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (filter === "unread" && !((c.unreadCount ?? 0) > 0)) return false;
      if (filter === "starred" && !c.starred) return false;
      if (tagFilter && !(contactTags.get(c.contactId) ?? []).includes(tagFilter)) {
        return false;
      }
      if (!q) return true;
      return (
        (c.contactName ?? "").toLowerCase().includes(q) ||
        (c.contactPhone ?? "").toLowerCase().includes(q)
      );
    });
  }, [conversations, filter, search, tagFilter, contactTags]);

  const basePath = saPath("/conversations");
  const detailSelected = pathname !== basePath;
  const activeContactId = detailSelected
    ? pathname.slice(basePath.length + 1)
    : undefined;

  return (
    <div className="mx-auto flex h-[calc(100vh-9rem)] min-h-[480px] w-full max-w-6xl gap-4">
      <div
        className={cn(
          "flex w-full shrink-0 flex-col gap-3 lg:w-[340px]",
          detailSelected && "hidden lg:flex",
        )}
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Conversations</h1>
          <p className="text-sm text-muted-foreground">
            Every SMS &amp; WhatsApp thread, one place.
          </p>
        </div>

        {selected.size > 0 ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
            <span className="text-xs font-medium">
              {selected.size} selected
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setBulkTagOpen(true)}
              >
                <TagIcon className="mr-1 h-3 w-3" />
                Add tag
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => setConfirmDeleteOpen(true)}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={clearSelection}
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterPill>
          <FilterPill active={filter === "unread"} onClick={() => setFilter("unread")}>
            Unread{unreadTotal > 0 ? ` (${unreadTotal})` : ""}
          </FilterPill>
          <FilterPill active={filter === "starred"} onClick={() => setFilter("starred")}>
            <Star className="mr-1 inline h-3 w-3" />
            Starred{starredTotal > 0 ? ` (${starredTotal})` : ""}
          </FilterPill>
        </div>

        {availableTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {availableTags.map(([tag, count]) => (
              <FilterPill
                key={tag}
                active={tagFilter === tag}
                onClick={() => setTagFilter((prev) => (prev === tag ? null : tag))}
              >
                <TagIcon className="mr-1 inline h-3 w-3" />
                {tag} ({count})
              </FilterPill>
            ))}
          </div>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone"
            className="pl-8"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <ListSkeleton />
          ) : (
            <ConversationList
              conversations={visible}
              basePath={basePath}
              activeContactId={activeContactId}
              selectedIds={selected}
              onToggleSelect={toggleSelect}
            />
          )}
        </div>
      </div>

      <div
        className={cn(
          "min-w-0 flex-1 overflow-hidden",
          !detailSelected && "hidden lg:block",
        )}
      >
        {children}
      </div>

      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size} conversation{selected.size === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              This deletes the underlying contact{selected.size === 1 ? "" : "s"}{" "}
              entirely, along with their message history. Any contact still
              linked to a deal, task, quote, or other record is skipped
              instead of deleted. This action can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkTagOpen} onOpenChange={setBulkTagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Tag {selected.size} contact{selected.size === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              Adds one tag to every selected contact. Existing tags are kept.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleBulkAddTag} className="space-y-4">
            <Input
              autoFocus
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
              placeholder="Tag name"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBulkTagOpen(false)}
                disabled={taggingBulk}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={taggingBulk || !bulkTagInput.trim()}>
                {taggingBulk ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Add tag
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-56 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
