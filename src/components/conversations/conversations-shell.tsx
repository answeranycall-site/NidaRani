"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Search, Star, Tag as TagIcon } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToConversations } from "@/lib/firestore/conversations";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import { Input } from "@/components/ui/input";
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

  useEffect(() => {
    if (authLoading || !user || !subAccountId) return;
    setLoading(true);
    const unsub = subscribeToConversations(subAccountId, (list) => {
      setConversations(list);
      setLoading(false);
    });
    return () => unsub();
  }, [user, subAccountId, authLoading]);

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
