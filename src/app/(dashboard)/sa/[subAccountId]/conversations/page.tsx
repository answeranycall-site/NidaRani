"use client";

import { MessagesSquare } from "lucide-react";

/**
 * Rendered in the shell's right-hand pane when no conversation is selected
 * (desktop only — on mobile this route shows just the list, per
 * ConversationsShell's responsive behavior).
 */
export default function ConversationsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center rounded-2xl border bg-card/50 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <MessagesSquare className="h-6 w-6 text-primary" />
      </div>
      <h2 className="text-base font-semibold">No conversation selected</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        Pick a conversation from the list to view the thread.
      </p>
    </div>
  );
}
