"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown, Mail, Phone, Building2, Trash2, X } from "lucide-react";
import type { Contact } from "@/types/contacts";
import type { TerritoryDoc } from "@/types";
import { SourceBadge } from "@/components/contacts/source-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useSubAccount } from "@/context/sub-account-context";

interface ContactBlocker {
  type: string;
  label: string;
  count: number;
}

interface Props {
  contacts: Contact[];
  search: string;
  /**
   * Optional — when the sub-account has territory scoping on, the
   * page passes the active territory list so the table can render a
   * "Territory" column. Empty array (default) hides the column.
   */
  territories?: TerritoryDoc[];
}

type BulkState =
  | { phase: "checking" }
  | {
      phase: "confirm";
      deletable: Contact[];
      blocked: { contact: Contact; blockers: ContactBlocker[] }[];
    }
  | { phase: "deleting" };

export function ContactsTable({ contacts, search, territories = [] }: Props) {
  const { subAccount, saPath } = useSubAccount();
  const showTerritoryCol = subAccount?.territoryScopingEnabled === true;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkState, setBulkState] = useState<BulkState>({ phase: "checking" });

  const territoryById = useMemo(() => {
    const m = new Map<string, TerritoryDoc>();
    for (const t of territories) m.set(t.id, t);
    return m;
  }, [territories]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? contacts.filter(
          (c) =>
            c.name?.toLowerCase().includes(q) ||
            c.email?.toLowerCase().includes(q) ||
            c.company?.toLowerCase().includes(q),
        )
      : contacts;
    // No visible "Added" column anymore (replaced by Notes), so the
    // newest-first default order is applied here instead of via
    // TanStack sorting state.
    return [...base].sort(
      (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt),
    );
  }, [contacts, search]);

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  const toggleSelectAllVisible = useCallback(() => {
    setSelected((prev) => {
      const allSelected =
        filtered.length > 0 && filtered.every((c) => prev.has(c.id));
      if (allSelected) return new Set();
      const next = new Set(prev);
      for (const c of filtered) next.add(c.id);
      return next;
    });
  }, [filtered]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function openBulkDelete() {
    setBulkOpen(true);
    setBulkState({ phase: "checking" });
    const ids = Array.from(selected);
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await fetch(`/api/contacts/${id}?check=1`);
          const data = (await res.json().catch(() => ({}))) as {
            deletable?: boolean;
            blockers?: ContactBlocker[];
          };
          return { id, deletable: !!data.deletable, blockers: data.blockers ?? [] };
        } catch {
          return {
            id,
            deletable: false,
            blockers: [{ type: "error", label: "check failed", count: 1 }],
          };
        }
      }),
    );
    const deletable: Contact[] = [];
    const blocked: { contact: Contact; blockers: ContactBlocker[] }[] = [];
    for (const r of results) {
      const c = byId.get(r.id);
      if (!c) continue;
      if (r.deletable) deletable.push(c);
      else blocked.push({ contact: c, blockers: r.blockers });
    }
    setBulkState({ phase: "confirm", deletable, blocked });
  }

  async function confirmBulkDelete() {
    if (bulkState.phase !== "confirm") return;
    const targets = bulkState.deletable;
    setBulkState({ phase: "deleting" });
    const results = await Promise.all(
      targets.map(async (c) => {
        try {
          const res = await fetch(`/api/contacts/${c.id}`, { method: "DELETE" });
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    const succeeded = results.filter(Boolean).length;
    const failed = results.length - succeeded;
    if (succeeded > 0) {
      toast.success(`Deleted ${succeeded} contact${succeeded === 1 ? "" : "s"}.`);
    }
    if (failed > 0) {
      toast.error(
        `${failed} contact${failed === 1 ? "" : "s"} couldn't be deleted.`,
      );
    }
    setSelected(new Set());
    setBulkOpen(false);
  }

  const columns = useMemo<ColumnDef<Contact>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={allVisibleSelected}
            onCheckedChange={toggleSelectAllVisible}
            aria-label="Select all contacts"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={selected.has(row.original.id)}
            onCheckedChange={() => toggleSelect(row.original.id)}
            aria-label={`Select ${row.original.name || "contact"}`}
          />
        ),
      },
      {
        accessorKey: "name",
        header: "Name",
        enableSorting: true,
        cell: ({ row }) => (
          <Link
            href={saPath(`/contacts/${row.original.id}`)}
            className="font-medium text-foreground hover:text-primary hover:underline"
          >
            {row.original.name || "Unnamed"}
          </Link>
        ),
      },
      {
        accessorKey: "email",
        header: "Email",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.email ? (
            <span className="text-sm text-muted-foreground">
              {row.original.email}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.phone ? (
            <span className="text-sm text-muted-foreground">
              {row.original.phone}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "company",
        header: "Company",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.company ? (
            <span className="text-sm">{row.original.company}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "source",
        header: "Source",
        enableSorting: false,
        cell: ({ row }) => <SourceBadge source={row.original.source} />,
      },
      {
        accessorKey: "tags",
        header: "Tags",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.tags && row.original.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {row.original.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      ...(showTerritoryCol
        ? [
            {
              accessorKey: "territoryId",
              header: "Territory",
              enableSorting: false,
              cell: ({ row }) => {
                const id = row.original.territoryId;
                const t = id ? territoryById.get(id) : null;
                // No explicit territory resolves to Global — the shared floor.
                if (!t) {
                  return <span className="text-sm">Global</span>;
                }
                return (
                  <span className="text-sm">
                    {t.name}
                    {t.status === "archived" && (
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        archived
                      </span>
                    )}
                  </span>
                );
              },
            } as ColumnDef<Contact>,
          ]
        : []),
      {
        accessorKey: "lastNoteSnippet",
        header: "Notes",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.lastNoteSnippet ? (
            <span
              className="block max-w-[220px] truncate text-sm text-muted-foreground"
              title={row.original.lastNoteSnippet}
            >
              {row.original.lastNoteSnippet}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
    ],
    [
      saPath,
      showTerritoryCol,
      territoryById,
      allVisibleSelected,
      selected,
      toggleSelect,
      toggleSelectAllVisible,
    ],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (contacts.length === 0) {
    return null;
  }

  if (filtered.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-12 text-center">
        <p className="text-sm text-muted-foreground">
          No contacts match &ldquo;{search}&rdquo;.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Bulk selection bar — desktop only, matches the checkbox column */}
      {selected.size > 0 && (
        <div className="mb-2 hidden items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 md:flex">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <X className="mr-1 h-3.5 w-3.5" />
              Clear
            </Button>
            <Button variant="destructive" size="sm" onClick={openBulkDelete}>
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={cn(
                        "px-2.5 py-2 font-semibold",
                        canSort && "cursor-pointer select-none hover:text-foreground",
                      )}
                      onClick={
                        canSort
                          ? header.column.getToggleSortingHandler()
                          : undefined
                      }
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {canSort &&
                          (sorted === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" />
                          ))}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  "border-b last:border-b-0 transition-colors hover:bg-muted/30",
                  selected.has(row.original.id) && "bg-muted/30",
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-2.5 py-1.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="space-y-3 md:hidden">
        {table.getRowModel().rows.map((row) => {
          const c = row.original;
          return (
            <Link
              key={c.id}
              href={saPath(`/contacts/${c.id}`)}
              className="block rounded-xl border bg-card p-4 transition-colors hover:bg-muted/30"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{c.name || "Unnamed"}</p>
                  {c.email && (
                    <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      {c.email}
                    </p>
                  )}
                  {c.phone && (
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                      <Phone className="h-3.5 w-3.5 shrink-0" />
                      {c.phone}
                    </p>
                  )}
                  {c.company && (
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                      <Building2 className="h-3.5 w-3.5 shrink-0" />
                      {c.company}
                    </p>
                  )}
                  {c.tags && c.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <SourceBadge source={c.source} />
              </div>
            </Link>
          );
        })}
      </div>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selected.size} contact{selected.size === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>
              {bulkState.phase === "checking" &&
                "Checking which contacts are safe to delete…"}
              {bulkState.phase === "deleting" && "Deleting…"}
              {bulkState.phase === "confirm" &&
                (bulkState.blocked.length === 0
                  ? "This can't be undone."
                  : `${bulkState.deletable.length} contact${bulkState.deletable.length === 1 ? "" : "s"} will be deleted. ${bulkState.blocked.length} can't be deleted because they're linked to other records.`)}
            </DialogDescription>
          </DialogHeader>

          {bulkState.phase === "confirm" && bulkState.blocked.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-sm">
              {bulkState.blocked.map(({ contact, blockers }) => (
                <li key={contact.id} className="text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {contact.name || contact.email || "Unnamed"}
                  </span>{" "}
                  — linked to{" "}
                  {blockers.map((b) => `${b.count} ${b.label}`).join(", ")}
                </li>
              ))}
            </ul>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                bulkState.phase !== "confirm" ||
                bulkState.deletable.length === 0
              }
              onClick={confirmBulkDelete}
            >
              {bulkState.phase === "deleting"
                ? "Deleting…"
                : `Delete${
                    bulkState.phase === "confirm"
                      ? ` ${bulkState.deletable.length}`
                      : ""
                  }`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
