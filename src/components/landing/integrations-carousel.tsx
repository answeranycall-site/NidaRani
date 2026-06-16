import type { IconType } from "react-icons";
import {
  SiGoogletagmanager,
  SiMake,
  SiMapbox,
  SiMeta,
  SiN8N,
  SiPaypal,
  SiResend,
  SiSlack,
  SiStripe,
  SiZapier,
} from "react-icons/si";

interface Integration {
  name: string;
  Icon: IconType;
  /**
   * Brand hex applied to the mark. `null` → inherit the theme foreground,
   * used for black brand marks (Mapbox / Resend / Vercel) that would
   * otherwise vanish on a dark background.
   */
  color: string | null;
}

/**
 * Real integrations only — the providers LeadStack is built on plus the
 * automation platforms reachable through the public REST API + signed
 * webhooks. Lead with Zapier/Make/n8n since they ARE the webhook story.
 */
const INTEGRATIONS: Integration[] = [
  { name: "Zapier", Icon: SiZapier, color: "#FF4F00" },
  { name: "Make", Icon: SiMake, color: "#6D00CC" },
  { name: "n8n", Icon: SiN8N, color: "#EA4B71" },
  { name: "Slack", Icon: SiSlack, color: "#611F69" },
  { name: "Stripe", Icon: SiStripe, color: "#635BFF" },
  { name: "PayPal", Icon: SiPaypal, color: "#0070BA" },
  { name: "Google Tag Manager", Icon: SiGoogletagmanager, color: "#246FDB" },
  { name: "Meta Pixel", Icon: SiMeta, color: "#0866FF" },
  { name: "Mapbox", Icon: SiMapbox, color: null },
  { name: "Resend", Icon: SiResend, color: null },
];

/**
 * Auto-scrolling logo marquee (GHL-style "integrates with your favorite
 * tools") that doubles as the webhook/API highlight. Reuses the shared
 * `animate-marquee` keyframe; the track is `w-max` so a -50% translate
 * lands exactly one duplicated set over for a seamless loop. Pauses on
 * hover.
 */
export function IntegrationsCarousel() {
  return (
    <section className="border-y bg-muted/30 py-12">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">
            Integrations
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tighter sm:text-3xl">
            Plug into your{" "}
            <span className="font-serif font-normal italic">
              favorite tools.
            </span>
          </h2>
          <p className="mt-3 text-sm text-muted-foreground lg:text-base">
            An open REST API and signed webhooks connect to Zapier, Make, n8n —
            or anything that speaks HTTP. No gated &ldquo;premium API&rdquo;
            tier.
          </p>
        </div>

        <div className="relative mt-8 overflow-hidden">
          {/* Edge fades */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-background to-transparent sm:w-24" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-background to-transparent sm:w-24" />

          <div className="flex w-max animate-marquee items-center gap-10">
            {[...INTEGRATIONS, ...INTEGRATIONS].map((item, i) => {
              const Icon = item.Icon;
              return (
                <div
                  key={`${item.name}-${i}`}
                  className="flex shrink-0 items-center gap-2.5 opacity-80 transition-opacity hover:opacity-100"
                >
                  <Icon
                    aria-hidden
                    className={item.color ? "h-7 w-7" : "h-7 w-7 text-foreground"}
                    style={item.color ? { color: item.color } : undefined}
                  />
                  <span className="whitespace-nowrap text-base font-medium text-muted-foreground">
                    {item.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
