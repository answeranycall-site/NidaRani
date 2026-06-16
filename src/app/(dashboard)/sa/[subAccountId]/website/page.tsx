"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import {
  AlertTriangle,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import {
  GITPAGE_SUBSCRIBE_URL,
  useGitpageStatus,
  type GitpageGateState,
} from "@/hooks/use-gitpage-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  blankBusinessDetails,
  blankServicesConfig,
  blankVslConfig,
  blankWebsiteConfig,
  sampleVslConfig,
  sampleWebsiteConfig,
  type BuildType,
  type Niche,
  type WebsiteBusinessDetails,
  type WebsiteConfig,
  type WebsiteDoc,
  type WebsiteServicesConfig,
} from "@/types/website";
import {
  isNicheKey,
  NICHE_KEYS,
  NICHE_META,
  nicheSample,
} from "@/lib/website/niches";
import {
  firstValidationError,
  validateWebsiteConfig,
  type ValidationErrors,
} from "@/lib/website/validation";
import {
  GITPAGE_COLOR_SCHEMES,
  GITPAGE_DESIGN_BUTTONS,
  GITPAGE_DESIGN_COLOR_PALETTES,
  GITPAGE_DESIGN_COMPONENTS,
  GITPAGE_DESIGN_CONTACT_FORM,
  GITPAGE_DESIGN_ICONS,
  GITPAGE_DESIGN_INTERACTIONS,
  GITPAGE_DESIGN_LAYOUT,
  GITPAGE_DESIGN_TYPOGRAPHY,
  GITPAGE_LANGUAGES,
} from "@/lib/website/gitpage-values";

/**
 * Phase 3 — real gitpage submit + status states. The page renders one of
 * four views based on the doc's status:
 *   draft         → editable form + Build site button
 *   queued/building → form locked + spinner + "Building…" message
 *   ready         → form locked + green banner with Visit site button
 *   failed        → form editable + red banner with the error
 */
export default function WebsitePage() {
  const { subAccountId, isAdmin, loading: subLoading } = useSubAccount();
  const [websiteDoc, setWebsiteDoc] = useState<WebsiteDoc | null>(null);
  const [config, setConfig] = useState<WebsiteConfig>(blankWebsiteConfig());
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Three-state activation gate driven by `system/gitpageStatus`. The
  // hook handles the snapshot subscription and the state derivation
  // (Ready / Subscribe-needed / Lapsed / Unknown).
  const { state: gateState, refresh: refreshGate } = useGitpageStatus();

  // Re-fire the heartbeat when the tab regains focus. Operators who go
  // to gitpage.site to subscribe and come back here get an instant
  // status update without waiting for the daily cron.
  useEffect(() => {
    function onFocus() {
      void refreshGate();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshGate]);

  useEffect(() => {
    if (!subAccountId) return;
    const ref = doc(
      getFirebaseDb(),
      `subAccounts/${subAccountId}/website/main`,
    );
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as WebsiteDoc;
          setWebsiteDoc(data);
          // Back-compat: docs written before the VSL feature shipped don't
          // carry build_type or video_link. Default them so the form
          // renders correctly without forcing a migration.
          setConfig({
            ...data.config,
            build_type: data.config.build_type ?? "local",
            video_link: data.config.video_link ?? "",
          });
        } else {
          setWebsiteDoc(null);
        }
        setHydrated(true);
      },
      () => setHydrated(true),
    );
    return () => unsub();
  }, [subAccountId]);


  const status = websiteDoc?.status ?? "draft";
  const isLocked = status === "queued" || status === "building" || status === "ready";
  const isInFlight = status === "queued" || status === "building";
  const buildType: BuildType = config.build_type ?? "local";
  const niche: Niche | null = isNicheKey(config.niche) ? config.niche : null;

  // Build-mode picker tracks which of the three top-level options is active.
  // When the user picks "niche" but hasn't chosen a tile yet, mode is "niche"
  // and config.niche stays null — the form is hidden behind the tile picker
  // until they commit. (BuildMode type is declared at module scope below.)
  const [mode, setMode] = useState<BuildMode>(() => {
    if (niche) return "niche";
    return buildType === "vsl" ? "standard_vsl" : "standard_local";
  });
  // Re-derive mode whenever the persisted doc flips back to draft (e.g. after
  // Rebuild) so the picker reflects the current config rather than stale UI
  // state from before the reset.
  useEffect(() => {
    if (status !== "draft") return;
    if (niche) setMode("niche");
    else if (buildType === "vsl") setMode("standard_vsl");
    else setMode("standard_local");
  }, [status, niche, buildType]);

  function switchMode(next: BuildMode) {
    if (next === mode) return;
    setMode(next);
    setErrors({});
    if (next === "standard_local") {
      setConfig(blankWebsiteConfig());
    } else if (next === "standard_vsl") {
      setConfig(blankVslConfig());
    } else {
      // Niche mode — start from a blank local until the user picks a tile.
      setConfig({ ...blankWebsiteConfig(), niche: null });
    }
  }

  function selectNiche(key: Niche, asBuildType: BuildType) {
    const meta = NICHE_META[key];
    const base = asBuildType === "vsl" ? blankVslConfig() : blankWebsiteConfig();
    setConfig({
      ...base,
      niche: key,
      color_scheme: meta.defaultColorScheme,
      // Niche local builds force the page set; mirror it on the persisted config.
      ...(asBuildType === "local"
        ? {
            local_page_selections: {
              index: true,
              services: true,
              contact: true,
              privacy: true,
              terms: true,
            },
            services_config: { let_ai_do_services: true, services_list: "" },
            business_details: blankBusinessDetails(),
          }
        : {}),
    });
    setErrors({});
  }

  // Collapse the form when a build kicks off / a site is live; expand on
  // draft so the user can fill it in. Failed leaves the previous choice so
  // they can keep tweaking after expanding once.
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (status === "queued" || status === "building" || status === "ready") {
      setExpanded(false);
    } else if (status === "draft") {
      setExpanded(true);
    }
  }, [status]);

  function update<K extends keyof WebsiteConfig>(
    key: K,
    value: WebsiteConfig[K],
  ) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function togglePage(
    page: "services" | "contact" | "privacy" | "terms",
    next: boolean,
  ) {
    setConfig((prev) => {
      const sel = { ...prev.local_page_selections, [page]: next };
      const updated: WebsiteConfig = {
        ...prev,
        local_page_selections: sel,
      };
      if (page === "services") {
        updated.services_config = next
          ? prev.services_config ?? blankServicesConfig()
          : null;
      }
      if (page === "contact") {
        updated.business_details = next
          ? prev.business_details ?? blankBusinessDetails()
          : null;
      }
      return updated;
    });
  }

  function updateServices<K extends keyof WebsiteServicesConfig>(
    key: K,
    value: WebsiteServicesConfig[K],
  ) {
    setConfig((prev) =>
      prev.services_config
        ? {
            ...prev,
            services_config: { ...prev.services_config, [key]: value },
          }
        : prev,
    );
  }

  function updateBusiness<K extends keyof WebsiteBusinessDetails>(
    key: K,
    value: WebsiteBusinessDetails[K],
  ) {
    setConfig((prev) =>
      prev.business_details
        ? {
            ...prev,
            business_details: { ...prev.business_details, [key]: value },
          }
        : prev,
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const validation = validateWebsiteConfig(config);
    setErrors(validation);
    const firstError = firstValidationError(validation);
    if (firstError) {
      toast.error(firstError);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/website/build`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: ValidationErrors;
        formResponseId?: string;
      };
      if (!res.ok) {
        if (payload.fieldErrors) setErrors(payload.fieldErrors);
        throw new Error(payload.error ?? "Could not start build.");
      }
      toast.success("Build started — gitpage will let us know when it's live.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start build.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (subLoading || !hydrated) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="h-7 w-48 animate-pulse rounded bg-muted" />
        <div className="h-72 animate-pulse rounded-2xl bg-muted/40" />
        <div className="h-72 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl rounded-2xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Only sub-account admins can build the website.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <Globe className="h-4 w-4" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight">Website</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Build a marketing site for this client via gitpage.site. Fill in
            the details, hit Build, and we&apos;ll return a live URL in a
            minute or two.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isLocked || submitting || (mode === "niche" && !niche)}
          onClick={() => {
            if (niche) {
              setConfig(nicheSample(niche, buildType)());
              toast.success(
                `Sample data loaded — ${NICHE_META[niche].label} ${buildType === "vsl" ? "VSL" : "site"}.`,
              );
            } else if (buildType === "vsl") {
              setConfig(sampleVslConfig());
              toast.success("Sample data loaded — coaching VSL.");
            } else {
              setConfig(sampleWebsiteConfig());
              toast.success("Sample data loaded — Starbucks Chadstone.");
            }
            setErrors({});
          }}
        >
          Sample
        </Button>
      </header>

      {/* Activation gate — when the operator hasn't pasted a
          GITPAGE_API_KEY yet (or it was rejected with a 401), replace the
          draft form entirely with the appropriate panel. Existing
          published sites stay live regardless. */}
      {gateState.kind === "subscribe-needed" && status === "draft" ? (
        <ActivationGate state={gateState} onRefresh={refreshGate} />
      ) : null}

      {/* Summary card — replaces the form once a build has been started.
          Click the + to re-expand and tweak the inputs. */}
      {websiteDoc && status !== "draft" && (
        <SummaryCard
          heading={config.heading}
          status={status}
          liveUrl={websiteDoc.liveUrl}
          errorMessage={websiteDoc.errorMessage}
          partialErrors={websiteDoc.partialErrors}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          subAccountId={subAccountId}
        />
      )}

      {expanded && gateState.kind !== "subscribe-needed" && (
      <div className="relative">
      <fieldset disabled={isLocked || submitting} className="space-y-6">
        {/* Build mode — Standard local / Standard VSL / Niche template */}
        <Section
          title="Site type"
          description="Pick the kind of site to generate — switching clears the form."
        >
          <BuildModePicker
            value={mode}
            onChange={switchMode}
            disabled={isLocked || submitting}
          />
        </Section>

        {/* Niche tile picker — only when mode is niche and no niche has been
            picked yet. Once a tile is clicked, niche is set and this section
            disappears so the regular form takes over. */}
        {mode === "niche" && !niche && (
          <Section
            title="Pick your niche"
            description="Each niche ships a research-backed design system, section structure, and copy tone. Click a tile to start filling in the details."
          >
            <NicheTilePicker
              onPick={selectNiche}
              disabled={isLocked || submitting}
            />
          </Section>
        )}

        {/* Niche summary chip — once the user has picked a tile, show what
            they picked + a one-click "change niche" affordance so they can
            re-open the picker without nuking unrelated form fields. */}
        {mode === "niche" && niche && (
          <Section
            title="Niche template"
            description="The design system, section structure, and copy tone are locked to this niche. Click change to pick a different one."
          >
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
              <div className="flex items-center gap-3">
                <span className="text-2xl leading-none">
                  {NICHE_META[niche].emoji}
                </span>
                <div>
                  <p className="text-sm font-medium">
                    {NICHE_META[niche].label}
                    {" · "}
                    {buildType === "vsl" ? "VSL funnel" : "Site"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {NICHE_META[niche].description}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isLocked || submitting}
                onClick={() => {
                  setConfig({ ...blankWebsiteConfig(), niche: null });
                  setErrors({});
                }}
              >
                Change
              </Button>
            </div>
          </Section>
        )}

        {/* The rest of the form is hidden until either standard mode is
            picked or a niche tile has been selected. This keeps the picker
            uncluttered while the user is still deciding what to build. */}
        {(mode !== "niche" || niche) && (
        <>
        {/* Basics */}
        <Section title="Basics" description="The core message — what the site is and who it's for.">
          <div className="grid gap-4">
            <Field label="Heading" hint="Max 80 characters." error={errors.heading}>
              <Input
                value={config.heading}
                onChange={(e) => update("heading", e.target.value)}
                maxLength={80}
                placeholder={buildType === "vsl" ? "Scale Your Coaching To $30k/Month" : "Acme Plumbing"}
              />
            </Field>
            <Field label="Hero statement" hint="Max 80 characters." error={errors.hero_statement}>
              <Textarea
                rows={2}
                value={config.hero_statement}
                onChange={(e) => update("hero_statement", e.target.value)}
                maxLength={80}
                placeholder="24-hour emergency plumbing in Sydney"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Language" error={errors.language}>
                <Select
                  value={config.language}
                  onChange={(v) => update("language", v)}
                  options={GITPAGE_LANGUAGES}
                />
              </Field>
              <Field label="Color scheme" error={errors.color_scheme}>
                <Select
                  value={config.color_scheme}
                  onChange={(v) =>
                    update("color_scheme", v as WebsiteConfig["color_scheme"])
                  }
                  options={GITPAGE_COLOR_SCHEMES}
                />
              </Field>
            </div>
            <Field
              label="Features"
              hint="Comma-separated 3 short items. Max 60 chars total."
              error={errors.features}
            >
              <Input
                value={config.features}
                onChange={(e) => update("features", e.target.value)}
                maxLength={60}
                placeholder="24/7 response, Licensed, Fixed-fee"
              />
            </Field>
            <Field
              label="Benefits"
              hint="Comma-separated 3 short items. Max 60 chars total."
              error={errors.benefits}
            >
              <Input
                value={config.benefits}
                onChange={(e) => update("benefits", e.target.value)}
                maxLength={60}
                placeholder="No surprises, Fast service, Guaranteed"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Contact email" error={errors.contact_details}>
                <Input
                  type="email"
                  value={config.contact_details}
                  onChange={(e) => update("contact_details", e.target.value)}
                  placeholder="hello@acme.com"
                />
              </Field>
              <Field label="Call-to-action link" error={errors.cta_link}>
                <Input
                  type="url"
                  value={config.cta_link}
                  onChange={(e) => update("cta_link", e.target.value)}
                  placeholder="https://book.acme.com"
                />
              </Field>
            </div>
          </div>
        </Section>

        {/* Video — VSL-only */}
        {buildType === "vsl" && (
          <Section
            title="Video"
            description="The VSL needs a video — paste the embed URL (not the watch URL)."
          >
            <Field
              label="Video link"
              hint="YouTube/Vimeo/Wistia embed URL. e.g. https://www.youtube.com/embed/dQw4w9WgXcQ"
              error={errors.video_link}
            >
              <Input
                type="url"
                value={config.video_link}
                onChange={(e) => update("video_link", e.target.value)}
                placeholder="https://www.youtube.com/embed/..."
              />
            </Field>
          </Section>
        )}

        {/* Pages — local-only, generic only. Niche templates lock the page
            set to [index, services, contact, privacy, terms] so this section
            is hidden in that case (see niche summary chip above). */}
        {buildType === "local" && !niche && (
        <Section title="Pages" description="Which pages should the site include?">
          <div className="space-y-2">
            <PageRow id="index" label="Home (index.html)" hint="Required" disabled checked />
            <PageRow
              id="services"
              label="Services (services.html)"
              checked={config.local_page_selections.services}
              onChange={(v) => togglePage("services", v)}
            />
            <PageRow
              id="contact"
              label="Contact (contact.html)"
              checked={config.local_page_selections.contact}
              onChange={(v) => togglePage("contact", v)}
            />
            <PageRow
              id="privacy"
              label="Privacy policy (privacy.html)"
              checked={config.local_page_selections.privacy}
              onChange={(v) => togglePage("privacy", v)}
            />
            <PageRow
              id="terms"
              label="Terms (terms.html)"
              checked={config.local_page_selections.terms}
              onChange={(v) => togglePage("terms", v)}
            />
          </div>
        </Section>
        )}

        {/* Services config — conditional for generic local; always shown for
            niche local. For niche, the AI toggle becomes "use niche default
            seed" — gitpage ships a research-backed services seed when no
            servicesList is provided. */}
        {buildType === "local" && config.local_page_selections.services && config.services_config && (
          <Section
            title="Services"
            description={
              niche
                ? `Optional. Leave the toggle on to use the ${NICHE_META[niche].label} default services seed, or untick to provide your own.`
                : "Used to populate the services.html page."
            }
          >
            <div className="space-y-4">
              <label className="flex items-center gap-3 rounded-lg border bg-background p-3">
                <Checkbox
                  checked={config.services_config.let_ai_do_services}
                  onCheckedChange={(c) =>
                    updateServices("let_ai_do_services", c === true)
                  }
                />
                <div>
                  <p className="text-sm font-medium">
                    {niche
                      ? "Use the niche default services seed"
                      : "Let AI generate the services list"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {niche
                      ? "Research-backed default for this niche (e.g. Plumbing / HVAC / Electrical / Roofing for Home Services). User-supplied services always win."
                      : "gitpage writes services from your features + benefits."}
                  </p>
                </div>
              </label>
              {!config.services_config.let_ai_do_services && (
                <Field
                  label="Services list"
                  hint="Comma-separated."
                  error={errors["services_config.services_list"]}
                >
                  <Textarea
                    rows={3}
                    value={config.services_config.services_list}
                    onChange={(e) =>
                      updateServices("services_list", e.target.value)
                    }
                    placeholder="Dine-In, Takeout, Catering, Private Events"
                  />
                </Field>
              )}
            </div>
          </Section>
        )}

        {/* Business details — conditional for generic local; always required
            for niche local since contact.html is forced on. */}
        {buildType === "local" && config.local_page_selections.contact && config.business_details && (
          <Section
            title="Business details"
            description={
              niche
                ? "Required — niche templates ship contact.html with name, address, and phone."
                : "Used to populate the contact.html page."
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Business name" error={errors["business_details.business_name"]}>
                <Input value={config.business_details.business_name} onChange={(e) => updateBusiness("business_name", e.target.value)} />
              </Field>
              <Field label="Phone">
                <Input value={config.business_details.business_phone} onChange={(e) => updateBusiness("business_phone", e.target.value)} />
              </Field>
              <Field label="Street" error={errors["business_details.business_street"]}>
                <Input value={config.business_details.business_street} onChange={(e) => updateBusiness("business_street", e.target.value)} />
              </Field>
              <Field label="City" error={errors["business_details.business_city"]}>
                <Input value={config.business_details.business_city} onChange={(e) => updateBusiness("business_city", e.target.value)} />
              </Field>
              <Field label="State / region">
                <Input value={config.business_details.business_state} onChange={(e) => updateBusiness("business_state", e.target.value)} />
              </Field>
              <Field label="Country">
                <Input value={config.business_details.business_country} onChange={(e) => updateBusiness("business_country", e.target.value)} />
              </Field>
              <Field label="Postcode / ZIP">
                <Input value={config.business_details.business_zip} onChange={(e) => updateBusiness("business_zip", e.target.value)} />
              </Field>
              <Field label="Business email">
                <Input type="email" value={config.business_details.business_email} onChange={(e) => updateBusiness("business_email", e.target.value)} />
              </Field>
              <Field label="Google rating" hint="e.g. 4.8">
                <Input value={config.business_details.google_rating} onChange={(e) => updateBusiness("google_rating", e.target.value)} />
              </Field>
              <Field label="Google review count" hint="e.g. 127">
                <Input value={config.business_details.google_review_count} onChange={(e) => updateBusiness("google_review_count", e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Opening hours" hint='Free-text, e.g. "Mon-Fri 8-6, Sat 10-2".'>
                  <Textarea rows={2} value={config.business_details.opening_hours} onChange={(e) => updateBusiness("opening_hours", e.target.value)} />
                </Field>
              </div>
            </div>
          </Section>
        )}

        {/* Design */}
        <Section title="Design" description="Pick a style — gitpage applies these consistently.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Color palette" error={errors.design_color_palette}>
              <Select
                value={config.design_color_palette}
                onChange={(v) => update("design_color_palette", v)}
                options={GITPAGE_DESIGN_COLOR_PALETTES}
              />
            </Field>
            {config.design_color_palette === "Custom" && (
              <Field
                label="Custom colours"
                hint='Three hex values, e.g. "#5B4BFF,#EEF0FF,#00E5A8".'
                error={errors.custom_colors}
              >
                <Input
                  value={config.custom_colors}
                  onChange={(e) => update("custom_colors", e.target.value)}
                  placeholder="#5B4BFF,#EEF0FF,#00E5A8"
                />
              </Field>
            )}
            <Field label="Typography">
              <Select
                value={config.design_typography}
                onChange={(v) => update("design_typography", v)}
                options={GITPAGE_DESIGN_TYPOGRAPHY}
              />
            </Field>
            <Field label="Layout">
              <Select
                value={config.design_layout}
                onChange={(v) => update("design_layout", v)}
                options={GITPAGE_DESIGN_LAYOUT}
              />
            </Field>
            <Field label="Components">
              <Select
                value={config.design_components}
                onChange={(v) => update("design_components", v)}
                options={GITPAGE_DESIGN_COMPONENTS}
              />
            </Field>
            <Field label="Interactions">
              <Select
                value={config.design_interactions}
                onChange={(v) => update("design_interactions", v)}
                options={GITPAGE_DESIGN_INTERACTIONS}
              />
            </Field>
            <Field label="Buttons">
              <Select
                value={config.design_buttons}
                onChange={(v) => update("design_buttons", v)}
                options={GITPAGE_DESIGN_BUTTONS}
              />
            </Field>
            <Field label="Contact form">
              <Select
                value={config.design_contact_form}
                onChange={(v) => update("design_contact_form", v)}
                options={GITPAGE_DESIGN_CONTACT_FORM}
              />
            </Field>
            <Field label="Icons">
              <Select
                value={config.design_icons}
                onChange={(v) => update("design_icons", v)}
                options={GITPAGE_DESIGN_ICONS}
              />
            </Field>
          </div>
        </Section>

        {/* FAQ */}
        <Section title="FAQ" description="Optional auto-generated FAQ section.">
          <label className="flex items-center gap-3 rounded-lg border bg-background p-3">
            <Checkbox
              checked={config.include_faq}
              onCheckedChange={(c) => update("include_faq", c === true)}
            />
            <div>
              <p className="text-sm font-medium">Include FAQ section</p>
              <p className="text-xs text-muted-foreground">
                gitpage generates the questions and answers from your features + benefits.
              </p>
            </div>
          </label>
        </Section>
        </>
        )}
      </fieldset>
      {isInFlight && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-background/60 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 rounded-full border bg-background px-4 py-2 shadow-md">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <p className="text-sm font-medium">Building your site…</p>
          </div>
        </div>
      )}
      </div>
      )}

      {/* Build button — hidden while building/ready (the banner has its own
          actions) and hidden entirely when the activation gate is up. */}
      {(status === "draft" || status === "failed") &&
        gateState.kind !== "subscribe-needed" && (
          <div className="flex items-center justify-between rounded-2xl border bg-gradient-to-br from-indigo-500/5 via-violet-500/5 to-pink-500/5 p-5">
            <div>
              <p className="text-sm font-medium">
                {status === "failed" ? "Try the build again" : "Ready to build?"}
              </p>
              <p className="text-xs text-muted-foreground">
                Builds typically take 1–3 minutes. We&apos;ll show progress
                here.
              </p>
            </div>
            <Button type="submit" disabled={submitting}>
              <Sparkles className="mr-1 h-4 w-4" />
              {submitting ? "Submitting…" : "Build site"}
            </Button>
          </div>
        )}
    </form>
  );
}

function SummaryCard({
  heading,
  status,
  liveUrl,
  errorMessage,
  partialErrors,
  expanded,
  onToggle,
  subAccountId,
}: {
  heading: string;
  status: WebsiteDoc["status"];
  liveUrl: string | null;
  errorMessage: string | null;
  partialErrors: string[] | null;
  expanded: boolean;
  onToggle: () => void;
  subAccountId: string;
}) {
  const [resetting, setResetting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  // URL hidden by default — keeps the workspace screenshare-safe and
  // forces the cleaner "Visit" affordance instead of exposing the raw
  // hostname every time the page loads.
  const [urlShown, setUrlShown] = useState(false);
  const isInFlight = status === "queued" || status === "building";
  const title = (heading?.trim() || "Untitled site") + " Website";

  async function handleRecheck() {
    setRechecking(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/website/poll-now`,
        { method: "POST" },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        settled?: "ready" | "failed" | "client-error";
        deferred?: string;
      };
      if (!res.ok) {
        throw new Error(payload.error ?? "Could not re-check.");
      }
      if (payload.settled === "ready") {
        toast.success("Build is live — URL updated.");
      } else if (payload.settled === "failed") {
        toast.error("Build failed on gitpage's side.");
      } else if (payload.settled === "client-error") {
        toast.error("gitpage rejected the poll — check the error.");
      } else {
        toast.success("Still building — restarted the poll loop.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not re-check.");
    } finally {
      setRechecking(false);
    }
  }

  async function handleRebuild() {
    if (
      !confirm(
        "Reset to draft so you can edit and rebuild? The previous live site stays up until you delete the GitHub repo manually.",
      )
    )
      return;
    setResetting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website`, {
        method: "DELETE",
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not reset.");
      toast.success("Reset to draft. Edit the form and click Build site.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reset.");
    } finally {
      setResetting(false);
    }
  }

  // Per-status accent + secondary line below the title.
  const accentClass =
    status === "ready"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : status === "failed"
        ? "border-rose-500/30 bg-rose-500/5"
        : isInFlight
          ? "border-amber-500/30 bg-amber-500/5"
          : "bg-card";

  return (
    <div className={`rounded-2xl border ${accentClass}`}>
      <div className="flex items-center gap-3 p-4">
        {/* role="button" (not a <button>) because this header contains nested
            interactive children — the live-URL link + Show/Hide controls.
            Nesting <button>/<a> inside a <button> is invalid HTML and triggers
            a hydration error. Keyboard support is wired manually to match a
            native button. */}
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
          aria-label={expanded ? "Collapse form" : "Expand form"}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground">
            {expanded ? (
              <Minus className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{title}</p>
            {isInFlight && (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                {status === "queued"
                  ? "Build queued — gitpage is starting up…"
                  : "Building your site… (1–3 min)"}
              </p>
            )}
            {status === "ready" && liveUrl && (
              <div className="mt-0.5 flex items-center gap-2 text-xs">
                {urlShown ? (
                  <>
                    <a
                      href={liveUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 truncate text-primary hover:underline"
                    >
                      {liveUrl}
                    </a>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setUrlShown(false);
                      }}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      Hide
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-muted-foreground">URL hidden</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setUrlShown(true);
                      }}
                      className="shrink-0 text-primary hover:underline"
                    >
                      Show URL
                    </button>
                  </>
                )}
              </div>
            )}
            {status === "failed" && (
              <p className="mt-0.5 flex items-start gap-1.5 text-xs text-rose-700 dark:text-rose-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                <span className="line-clamp-2">
                  {errorMessage ?? "gitpage didn't return a live URL."}
                </span>
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          {isInFlight && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleRecheck}
              disabled={rechecking}
            >
              {rechecking ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              {rechecking ? "Checking…" : "Re-check now"}
            </Button>
          )}
          {status === "ready" && liveUrl && (
            <Button
              type="button"
              size="sm"
              render={<a href={liveUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              Visit
            </Button>
          )}
          {(status === "ready" || status === "failed") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleRebuild}
              disabled={resetting}
            >
              {resetting ? "Resetting…" : "Rebuild"}
            </Button>
          )}
        </div>
      </div>

      {partialErrors && partialErrors.length > 0 && (
        <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Some pages had issues during generation:
          </p>
          <ul className="mt-1 list-disc pl-5 text-[11px] text-amber-700/90 dark:text-amber-400/90">
            {partialErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-card p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<string>;
}) {
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function ActivationGate({
  state,
  onRefresh,
}: {
  state: GitpageGateState;
  onRefresh: () => Promise<boolean>;
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const ok = await onRefresh();
      toast[ok ? "success" : "error"](
        ok ? "Status refreshed." : "Couldn't refresh — try again.",
      );
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);

  if (state.kind !== "subscribe-needed") return null;
  const keyInvalid = state.lastError === "401_invalid_api_key";

  return (
    <section className="rounded-2xl border bg-gradient-to-br from-indigo-500/5 via-violet-500/5 to-pink-500/5 p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Lock className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">
            {keyInvalid ? "Re-paste your API key" : "Add a website-builder key"}
          </h2>
          {keyInvalid ? (
            <p className="mt-1 text-sm text-muted-foreground">
              The website-builder API key was rejected — it may have been
              rotated upstream. Update <code>GITPAGE_API_KEY</code> in your
              hosting env vars and redeploy.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Spin up a marketing site for this client straight from the
              CRM once you&apos;ve dropped a website-builder API key into
              your env vars. Already have one? Set{" "}
              <code>GITPAGE_API_KEY</code> and redeploy — the Status tab
              on Agency home confirms when it&apos;s detected.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              render={
                <a
                  href={GITPAGE_SUBSCRIBE_URL}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              Get a key
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              Re-check
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

type BuildMode = "standard_local" | "standard_vsl" | "niche";

function BuildModePicker({
  value,
  onChange,
  disabled,
}: {
  value: BuildMode;
  onChange: (next: BuildMode) => void;
  disabled?: boolean;
}) {
  const options: Array<{ id: BuildMode; label: string; hint: string }> = [
    {
      id: "standard_local",
      label: "Standard local site",
      hint: "Multi-page site — home, services, contact, terms.",
    },
    {
      id: "standard_vsl",
      label: "Standard VSL funnel",
      hint: "Single page with a video and one call-to-action.",
    },
    {
      id: "niche",
      label: "Niche template",
      hint: "Pre-designed for a specific trade — research-backed sections + copy tone.",
    },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            disabled={disabled}
            aria-pressed={selected}
            className={
              (selected
                ? "border-primary bg-primary/5 ring-2 ring-primary/30"
                : "border-input bg-background hover:bg-muted/30") +
              " flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            }
          >
            <p className="text-sm font-medium">{opt.label}</p>
            <p className="text-[11px] text-muted-foreground">{opt.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

function NicheTilePicker({
  onPick,
  disabled,
}: {
  onPick: (niche: Niche, asBuildType: BuildType) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Websites
        </p>
        {NICHE_KEYS.map((key) => (
          <NicheTile
            key={`${key}-local`}
            niche={key}
            buildType="local"
            disabled={disabled}
            onClick={() => onPick(key, "local")}
          />
        ))}
      </div>
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          VSL funnels
        </p>
        {NICHE_KEYS.map((key) => (
          <NicheTile
            key={`${key}-vsl`}
            niche={key}
            buildType="vsl"
            disabled={disabled}
            onClick={() => onPick(key, "vsl")}
          />
        ))}
      </div>
    </div>
  );
}

function NicheTile({
  niche,
  buildType,
  disabled,
  onClick,
}: {
  niche: Niche;
  buildType: BuildType;
  disabled?: boolean;
  onClick: () => void;
}) {
  const meta = NICHE_META[niche];
  const suffix = buildType === "vsl" ? " VSL" : "";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-3 rounded-lg border border-input bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="text-2xl leading-none">{meta.emoji}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {meta.shortLabel}
          {suffix}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {meta.description}
        </p>
      </div>
    </button>
  );
}

function PageRow({
  id,
  label,
  hint,
  disabled,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  checked?: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor={`page-${id}`}
      className={
        disabled
          ? "flex cursor-not-allowed items-center gap-3 rounded-lg border bg-muted/30 p-3 opacity-70"
          : "flex cursor-pointer items-center gap-3 rounded-lg border bg-background p-3 hover:bg-muted/30"
      }
    >
      <Checkbox
        id={`page-${id}`}
        disabled={disabled}
        checked={checked}
        onCheckedChange={(c) => onChange?.(c === true)}
      />
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </label>
  );
}
