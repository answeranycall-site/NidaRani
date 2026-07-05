import { ConversationsShell } from "@/components/conversations/conversations-shell";

export default function ConversationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConversationsShell>{children}</ConversationsShell>;
}
