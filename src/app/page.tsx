import { LANDING_VARIANT } from "@/config/landing";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { resolveHeroVariant } from "@/lib/hero-variant-server";

import { AnnouncementBar } from "@/components/landing/announcement-bar";
import { Navbar as AACNavbar } from "@/components/landing/navbar";
import { Hero as AACHero } from "@/components/landing/hero";
import { IntegrationsCarousel } from "@/components/landing/integrations-carousel";
import { HowItWorks } from "@/components/landing/how-it-works";
import { WorkspaceTour } from "@/components/landing/workspace-tour";
import { Features as AACFeatures } from "@/components/landing/features";
import { MidPageCta } from "@/components/landing/mid-page-cta";
import { Comparison } from "@/components/landing/comparison";
// import { Support } from "@/components/landing/support"; // hidden for now
import { MakeItYours } from "@/components/landing/make-it-yours";
import { TestimonialsCarousel } from "@/components/landing/testimonials-carousel";
import { Pricing as AACPricing } from "@/components/landing/pricing";
import { FAQ as AACFAQ } from "@/components/landing/faq";
import { CTA as AACCTA } from "@/components/landing/cta";
import { Footer as AACFooter } from "@/components/landing/footer";
import { ExitIntentModal } from "@/components/landing/exit-intent-modal";
import { SalesPopup } from "@/components/landing/sales-popup";
import { LiveVisitorBeacon } from "@/components/landing/live-visitor-beacon";

import { Navbar as CustomNavbar } from "@/components/landing-custom/navbar";
import { Hero as CustomHero } from "@/components/landing-custom/hero";
import { Features as CustomFeatures } from "@/components/landing-custom/features";
import { FAQ as CustomFAQ } from "@/components/landing-custom/faq";
import { CTA as CustomCTA } from "@/components/landing-custom/cta";
import { Footer as CustomFooter } from "@/components/landing-custom/footer";

/**
 * Renders one of two landing pages based on src/config/landing.ts.
 *
 * - "custom" — a generic agency-CRM landing the buyer brands as their own.
 *   Brand fields are resolved server-side from the agency doc (Agency →
 *   Settings → Branding), falling back to CUSTOM_BRAND for anything the
 *   owner hasn't set yet. THIS IS THE DEFAULT.
 * - "Answer Any Call" — the Answer Any Call-branded marketing landing used on the
 *   answeranycall.com demo site. Flip back to this only for the public demo.
 *
 * Flip LANDING_VARIANT to swap. Code-level defaults for the custom
 * variant live in src/config/landing.ts (CUSTOM_BRAND).
 */
export default async function HomePage() {
  if (LANDING_VARIANT === "custom") {
    const brand = await resolveCustomBrand();
    return (
      <div className="flex min-h-screen flex-col">
        <CustomNavbar brand={brand} />
        <main className="flex-1">
          <CustomHero brand={brand} />
          <CustomFeatures />
          <CustomFAQ brand={brand} />
          <CustomCTA brand={brand} />
        </main>
        <CustomFooter brand={brand} />
      </div>
    );
  }

  const heroVariant = await resolveHeroVariant();

  return (
    <div className="flex min-h-screen flex-col">
      <AnnouncementBar />
      <AACNavbar />
      <main className="flex-1">
        <AACHero variant={heroVariant} />
        <HowItWorks />
        <WorkspaceTour />
        <AACFeatures />
        <MidPageCta />
        <Comparison />
        {/* <Support /> — hidden for now; uncomment to restore */}
        <MakeItYours />
        <TestimonialsCarousel />
        <AACPricing />
        <IntegrationsCarousel />
        <AACFAQ />
        <AACCTA />
      </main>
      <AACFooter variant={heroVariant} />
      <ExitIntentModal />
      <SalesPopup />
      <LiveVisitorBeacon />
    </div>
  );
}
