import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Headset,
  Lock,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import type { ReactNode } from "react";

import { ChatLink } from "@/app/about/chat-cta";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Support-reality section. Breaks the "if I buy SaaS like GHL they'll
 * look after me" belief and exposes GHL's real cost to reach a human:
 * $297/mo base + $97/mo per sub-account AI Employee + $500/mo Premium
 * Support just to talk to a person instead of a bot.
 *
 * Server component (static) — mirrors <Comparison /> so it slots into the
 * same page flow without a client boundary. Same theme: primary eyebrow,
 * tracking-tighter heading with a serif-italic accent, rounded-2xl
 * bordered cards, indigo→violet→pink gradient accents.
 */
export function Support() {
  return (
    <section id="support" className="bg-muted/30 py-24">
      <div className="container mx-auto px-4">
        {/* Header — breaks the belief up front */}
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">
            Support, honestly
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tighter sm:text-5xl">
            Keep your $500 —{" "}
            <span className="font-serif font-normal italic">
              real support with a real person.
            </span>
          </h2>
        </div>

        {/* Myth vs reality — hidden for now (toggle `false` to restore) */}
        {false && (
          <div className="mx-auto mt-12 grid max-w-4xl gap-4 md:grid-cols-2">
            <BeliefCard
              kind="myth"
              label="The belief"
              title="“They’ll look after me.”"
              points={[
                "A team that knows your account and has your back",
                "A real person when something breaks at 2am",
                "Onboarding that actually gets you live",
              ]}
            />
            <BeliefCard
              kind="reality"
              label="The reality"
              title="A bot and a price gate."
              points={[
                "Tier-1 chatbot trained to deflect, not solve",
                "Human support is a $500/mo Premium add-on",
                "You’re renting — leverage runs one direction",
              ]}
            />
          </div>
        )}

        {/* Two showpieces: the chat paywall mockup + the real bill */}
        <div className="mx-auto mt-12 grid max-w-4xl items-stretch gap-6 lg:grid-cols-2">
          <ChatPaywallMockup />
          <RealBillMockup />
        </div>

        {/* The LeadStack counter — support when you actually own it */}
        <div className="mx-auto mt-12 max-w-4xl">
          <div className="relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-background p-6 shadow-sm sm:p-8">
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-emerald-500/15 to-emerald-400/10 blur-3xl" />

            <div className="relative">
              <div className="text-center">
                <p className="text-sm font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  The LeadStack difference
                </p>
                <h3 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Support that can&apos;t be{" "}
                  <span className="font-serif font-normal italic">
                    held hostage.
                  </span>
                </h3>
                <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground lg:text-base">
                  You own the code. There&apos;s no vendor deciding whether your
                  problem is worth a human — because the answer isn&apos;t behind
                  a $500/mo wall, it&apos;s in your repo.
                </p>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <OwnCard
                  icon={<Code2 className="h-4 w-4" />}
                  title="You own the repo"
                  body="Full transparency — it's all in your hands. Nothing hidden behind a vendor, so you get answers fast."
                />
                <OwnCard
                  icon={<ShieldCheck className="h-4 w-4" />}
                  title="No human paywall"
                  body="No $500/mo to reach a person. Help is your code, the docs, and real support — all included."
                />
                <OwnCard
                  icon={<Headset className="h-4 w-4" />}
                  title="Talk to a real person"
                  body="Real human support, Monday–Friday, 10am–4pm AEST. No bot wall, no $500/mo gate."
                  action={
                    <ChatLink>
                      Click here to start a chat →
                    </ChatLink>
                  }
                />
              </div>

              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button
                  render={<a href="#pricing" data-cta="support-section-primary" />}
                  size="lg"
                  className="cta-glow px-6 text-base"
                >
                  Own it for a one-time price
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
                <Button
                  render={<a href="#comparison" />}
                  variant="outline"
                  size="lg"
                  className="px-6 text-base"
                >
                  See the full cost breakdown
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Myth vs reality card ─────────────────────────────────────────── */

function BeliefCard({
  kind,
  label,
  title,
  points,
}: {
  kind: "myth" | "reality";
  label: string;
  title: string;
  points: string[];
}) {
  const accent =
    kind === "reality"
      ? {
          ring: "border-rose-500/30",
          dot: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
          icon: <X className="h-3.5 w-3.5" />,
          chip: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
        }
      : {
          ring: "border-amber-500/30",
          dot: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
          icon: <Sparkles className="h-3.5 w-3.5" />,
          chip: "bg-muted text-muted-foreground",
        };

  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-2xl border bg-background p-5",
        accent.ring,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-full",
            accent.dot,
          )}
        >
          {accent.icon}
        </span>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="text-base font-semibold tracking-tight">{title}</p>
        </div>
      </div>
      <ul className="mt-4 space-y-2.5">
        {points.map((p) => (
          <li key={p} className="flex gap-2 text-sm text-muted-foreground">
            <span
              className={cn(
                "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                accent.chip,
              )}
            >
              {kind === "reality" ? (
                <X className="h-2.5 w-2.5" />
              ) : (
                <Check className="h-2.5 w-2.5" />
              )}
            </span>
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Chat paywall mockup ──────────────────────────────────────────── */

function ChatPaywallMockup() {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-rose-500/30 bg-background shadow-sm">
      {/* Window chrome */}
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-3">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        </span>
        <span className="ml-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
          Support chat
        </span>
      </div>

      {/* Transcript */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <Bubble side="right">I&apos;ve been down for 2 hours. Can I talk to a real person?</Bubble>
        <Bubble side="left" bot>
          Hi! I&apos;m the AI Support Assistant 🤖 Have you tried clearing your
          cache and re-saving the snapshot?
        </Bubble>
        <Bubble side="right">No. I need a human.</Bubble>

        {/* The paywall */}
        <div className="mt-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <Lock className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">
              Live agent locked
            </span>
          </div>
          <p className="mt-1.5 text-sm text-foreground">
            Human support requires{" "}
            <span className="font-semibold">Premium Support — $500/mo</span>.
            Upgrade to chat with a person.
          </p>
        </div>
      </div>

      <p className="border-t px-4 py-2.5 text-center text-[11px] text-muted-foreground">
        Illustrative of how tiered SaaS support gates humans behind add-ons.
      </p>
    </div>
  );
}

function Bubble({
  side,
  bot,
  children,
}: {
  side: "left" | "right";
  bot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex", side === "right" ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
          side === "right"
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : bot
              ? "rounded-bl-sm bg-muted text-foreground"
              : "rounded-bl-sm bg-muted text-foreground",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* ── The real bill mockup ─────────────────────────────────────────── */

function RealBillMockup() {
  const lines = [
    { name: "GoHighLevel — base plan", note: "Agency / Pro", price: "$297/mo" },
    {
      name: "Premium Support",
      note: "just to reach a human, not a bot",
      price: "+$500/mo",
      highlight: true,
    },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-rose-500/30 bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-3">
        <Headset className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          The real price of a human
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <ul className="space-y-3">
          {lines.map((l) => (
            <li
              key={l.name}
              className="flex items-baseline justify-between gap-3"
            >
              <div>
                <p
                  className={cn(
                    "text-sm font-medium",
                    l.highlight && "text-amber-700 dark:text-amber-400",
                  )}
                >
                  {l.name}
                </p>
                <p className="text-[11px] text-muted-foreground">{l.note}</p>
              </div>
              <span
                className={cn(
                  "shrink-0 text-sm font-semibold tabular-nums",
                  l.highlight
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-foreground",
                )}
              >
                {l.price}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 border-t pt-4">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-sm font-semibold">To actually talk to a human</p>
              <p className="text-[11px] text-muted-foreground">
                base plan + Premium Support
              </p>
            </div>
            <div className="text-right">
              <p className="bg-gradient-to-r from-indigo-500 via-violet-500 to-pink-500 bg-clip-text text-2xl font-bold tabular-nums text-transparent">
                $797/mo
              </p>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                ≈ $9,564 / year
              </p>
            </div>
          </div>
        </div>

        <p className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
          That{" "}
          <span className="font-medium text-foreground">$500/mo</span>{" "}
          human-support line never goes away — you pay it every month you want a
          person instead of a bot.
        </p>
      </div>
    </div>
  );
}

/* ── LeadStack own-it card ────────────────────────────────────────── */

function OwnCard({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-emerald-500/15 bg-background/60 p-4">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        {icon}
      </span>
      <p className="mt-3 text-sm font-semibold tracking-tight">{title}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        {body}
      </p>
      {action && <p className="mt-2 text-[13px]">{action}</p>}
    </div>
  );
}
