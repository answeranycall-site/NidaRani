"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * One-at-a-time testimonial carousel with a slide choreography:
 * a card slides in from the right, holds centered for 3s, slides off to the
 * left, then after a 1s beat the next one comes in — looping. Prev/next
 * arrows sit at the screen edges so a visitor can flick back to one they
 * were reading.
 *
 * The slide + hold + exit is a single CSS keyframe (4.4s); `onAnimationEnd`
 * starts the 1s gap timer, then advances. `key={index}` remounts the card
 * so the animation restarts cleanly. Pauses on hover; under
 * `prefers-reduced-motion` the animation is off, so autoplay simply stops
 * (arrows still work). No dots — the rotation count stays unobtrusive.
 *
 * To add a testimonial, append to `TESTIMONIALS`. Keep quotes verbatim.
 */

interface Testimonial {
  quote: string;
  name: string;
  location: string;
  date: string;
  /**
   * Real, confirmed purchaser. Defaults to shown — every current entry is a
   * verified buyer, so the "Verified buyer" badge renders unless a future
   * entry explicitly sets `verified: false` (e.g. a non-customer endorsement).
   */
  verified?: boolean;
}

const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "We purchased the founders deal and have it all configured, it's awesome. Now I am making it my own with minor mods.",
    name: "Dynamite Business Ventures",
    location: "Sacramento, California",
    date: "27 May 2026",
  },
  {
    quote: "I got this up and running very quickly, really nice! Bye, bye GHL.",
    name: "Steve Miller Designs",
    location: "Canton, Ohio",
    date: "28 May 2026",
  },
  {
    quote:
      "Really impressed by the product and how the process went smooth. Definitely recommend if you want a great affordable crm for your business.",
    name: "Laurent M",
    location: "Saint-Denis, Réunion Island",
    date: "29 May 2026",
  },
  {
    quote:
      "For two years I'd been hunting for a GHL alternative for local small businesses — the ones who can't justify pricey SaaS subscriptions and don't have the patience to wrestle with them. LeadStack finally lets us help more of those businesses while running a more profitable one ourselves.",
    name: "Naaman Villanueva",
    location: "Los Angeles, California",
    date: "5 June 2026",
  },
  {
    quote:
      "After exploring tons of options, LeadStack was the only thing that came genuinely close to GoHighLevel — and I'm so glad I found it before locking into their expensive plans. Excited to build.",
    name: "Shree Win",
    location: "Los Angeles, California",
    date: "6 June 2026",
  },
  {
    quote:
      "I was about to sign up for GHL, then watched Ben's YouTube and took this instead — no regrets. I never knew the upside of actually owning your CRM until now: having the power to own it and make it yours is something else. With instructions walking you through exactly what to do - AI does the heavy lifting — you just log in a couple of times. Worth every penny.",
    name: "Haroon Qammar",
    location: "London, England",
    date: "10 June 2026",
  },
  {
    quote:
      "Just got set up and I've been working with the tool. A-MAZ-ING. I've already put some of my clients on this and it works like a charm.",
    name: "Jeff, Firestarter Labs",
    location: "Golden, Colorado",
    date: "14 June 2026",
  },
  {
    quote:
      "I purchased LeadStack a couple days ago and have it up and going. I'm tweaking it to work with a different payment provider — it's super easy to modify with Claude Code. Looking forward to not needing GHL. :)",
    name: "Haley Estes",
    location: "Chicago, Illinois",
    date: "15 June 2026",
  },
  {
    quote:
      "I build and customize CRMs for a living, and I was tired of juggling so many different platforms and automation tools. With LeadStack I can finally pull all the workflows I've built for clients into one CRM I own — built from the ground up for mortgage brokers in my country. Can't wait to get rid of GHL!",
    name: "Kyle Lesage",
    location: "Vancouver, British Columbia",
    date: "15 June 2026",
  },
];

/** Empty beat between one card leaving and the next arriving. */
const GAP_MS = 1000;

// enter 0.7s · hold 6s · exit 0.7s = 7.4s. Centered (full opacity) runs
// 9.5%→90.5% of 7.4s ≈ 0.7s→6.7s = the 6s read hold.
const SLIDE_CSS = `
@keyframes ls-testimonial-slide {
  0%     { transform: translateX(110vw); opacity: 0; }
  9.5%   { transform: translateX(0);     opacity: 1; }
  90.5%  { transform: translateX(0);     opacity: 1; }
  100%   { transform: translateX(-110vw); opacity: 0; }
}
.ls-testimonial-slide {
  animation: ls-testimonial-slide 7.4s ease-in-out forwards;
  will-change: transform, opacity;
}
.ls-testimonial-slide:hover {
  animation-play-state: paused;
}
@media (prefers-reduced-motion: reduce) {
  .ls-testimonial-slide { animation: none; }
}
`;

export function TestimonialsCarousel() {
  const count = TESTIMONIALS.length;
  const [index, setIndex] = useState(0);
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGap = () => {
    if (gapTimer.current) {
      clearTimeout(gapTimer.current);
      gapTimer.current = null;
    }
  };
  useEffect(() => clearGap, []);

  const next = useCallback(() => {
    clearGap();
    setIndex((i) => (i + 1) % count);
  }, [count]);
  const prev = useCallback(() => {
    clearGap();
    setIndex((i) => (i - 1 + count) % count);
  }, [count]);

  // Fires when a card finishes sliding off-left. Hold the empty beat, then
  // bring in the next. Never fires under reduced motion (no animation), so
  // autoplay just stops — manual nav still works.
  const handleEnd = useCallback(() => {
    clearGap();
    gapTimer.current = setTimeout(
      () => setIndex((i) => (i + 1) % count),
      GAP_MS,
    );
  }, [count]);

  const t = TESTIMONIALS[index];

  return (
    <section
      id="reviews"
      aria-label="Customer testimonials"
      aria-roledescription="carousel"
      className="relative scroll-mt-16 overflow-hidden border-y py-16"
    >
      <style>{SLIDE_CSS}</style>

      <div className="container mx-auto px-4 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          What buyers are saying
        </p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tighter sm:text-4xl">
          Real teams, already{" "}
          <span className="font-serif font-normal italic">shipping</span>.
        </h2>
      </div>

      {/* Full-width row: arrows anchor to the card's vertical center but sit
          at the screen edges. */}
      <div className="relative mt-10">
        <button
          type="button"
          onClick={prev}
          aria-label="Previous testimonial"
          className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground sm:left-6"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={next}
          aria-label="Next testimonial"
          className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground sm:right-6"
        >
          <ChevronRight className="h-5 w-5" />
        </button>

        <div className="mx-auto flex max-w-3xl px-4">
          <figure
            key={index}
            onAnimationEnd={handleEnd}
            className="ls-testimonial-slide flex min-h-[380px] w-full flex-col justify-center rounded-2xl border bg-card px-6 py-8 sm:min-h-[320px] sm:px-12"
          >
            <div className="mb-4 flex justify-center gap-1">
              {[...Array(5)].map((_, s) => (
                <svg
                  key={s}
                  className="h-4 w-4 fill-yellow-500 text-yellow-500"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              ))}
            </div>
            <blockquote className="text-center text-lg font-medium leading-relaxed text-foreground sm:text-xl">
              &ldquo;{t.quote}&rdquo;
            </blockquote>
            <figcaption className="mt-6 text-center">
              <p className="text-sm font-semibold">{t.name}</p>
              <p className="text-xs text-muted-foreground">
                {t.location ? `${t.location} · ${t.date}` : t.date}
              </p>
              {t.verified !== false && (
                <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  <BadgeCheck className="h-3 w-3" />
                  Verified buyer
                </span>
              )}
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
