import type { Comparison } from "@/types/comparisons";

/**
 * GoHighLevel vs LeadStack — the flagship comparison page.
 *
 * GHL is the direct rival LeadStack is positioned head-to-head against, so
 * this page sees the highest converting search intent. Update pricing +
 * verification date when GHL changes their public tiers.
 *
 * Underlying-stack identifiers (Firebase, Twilio, Vapi, Resend, OpenRouter,
 * Vercel, Next.js, gitpage.site, specific AI model names, etc.) are
 * deliberately kept out of this file. Visitors shouldn't be able to
 * reconstruct LeadStack's architecture from the comparison page — that
 * information ships inside the repo they get after purchase.
 */
export const gohighlevelComparison: Comparison = {
  slug: "gohighlevel",
  competitorName: "GoHighLevel",
  competitorShortName: "GHL",
  metaTitle: "GoHighLevel vs LeadStack | All-in-One CRM Compared (2026)",
  metaDescription:
    "GoHighLevel vs LeadStack — feature, pricing, and ownership comparison. Why agencies are switching from $297/mo recurring to a self-hosted all-in-one CRM they own outright.",
  lastVerifiedDate: "June 2026",

  hero: {
    h1: "GoHighLevel vs LeadStack",
    subhead:
      "Both are all-in-one CRMs built for agencies. Only one of them lets you own the code, set your own prices, keep your client data on your own infrastructure, and walk away the day you decide to switch tools.",
    ctaLabel: "See LeadStack pricing",
  },

  pullQuote: {
    text: "GoHighLevel made the modern agency stack possible — one tool, one bill, every channel. LeadStack is the next step: the same surface area, but you own the code, the data, and the margin instead of renting them.",
    author: "The LeadStack team",
    role: "On why LeadStack exists",
  },

  painPoints: {
    heading: "Where GoHighLevel falls short",
    bullets: [
      {
        title: "$297 every month — for as long as you operate",
        body: "GoHighLevel's Unlimited tier is $297 per month, billed in perpetuity. There's no point at which you finish paying. Five years in, you've handed them roughly $17,800 and still don't own a single line of the platform you sell to your clients. The day you stop paying, the tool stops working.",
      },
      {
        title: "White-label is paint, not foundation",
        body: "GHL's white-label is real and well-executed — but it stops at the surface. You can change colors, logos, the login URL, the domain. You cannot change how the platform behaves, ship a feature your client asked for last Tuesday, or fork the codebase when GHL's product direction diverges from yours. Their roadmap is your roadmap.",
      },
      {
        title: "Their database holds your clients hostage",
        body: "Every contact, deal, conversation, and recorded call lives on GoHighLevel's infrastructure. Exporting is possible but partial — webhook history, recorded voice calls, attachment metadata, and automation execution logs are difficult to recover in usable shape. If GHL changes pricing, deprecates a feature, or you simply outgrow them, migration is a months-long project.",
      },
    ],
  },

  advantages: [
    {
      title: "You own the code, not a seat",
      body: "LeadStack is the full source code of an agency CRM you clone, deploy to your own cloud account, and brand as your own product. Every file — the UI, the API routes, the AI agent logic, the booking pages, the quote generator — is yours to read, modify, and extend. There is no platform behind LeadStack waiting to deprecate the feature you depend on.",
    },
    {
      title: "Pricing is a line on a vendor invoice, not a subscription",
      body: "After the one-time license, your only ongoing costs are the actual infrastructure your deployment consumes — cloud hosting, database storage, per-SMS, per-email, per-token AI. You pay your service providers directly at their published rates, with no platform markup baked into repackaged credits. Most agencies' total infrastructure spend is under $50/month for the first dozen sub-accounts.",
    },
    {
      title: "AI built on an open gateway — pick any model",
      body: "Web Chat, SMS auto-reply, and Voice agents all flow through a single AI gateway, configured per channel. One key routes turns to a fast default model, or you can override per channel to a heavier reasoning model from any of the major model families. When a better model ships, you switch with a config change — not a vendor partnership negotiation.",
    },
    {
      title: "White-label all the way down to the database",
      body: "Per-sub-account dedicated phone numbers. Per-sub-account verified email sending domains. Per-sub-account branding, API keys, webhook subscriptions, and a fully tenancy-scoped database so a leaked credential only ever sees one client's data. Every URL, every email, every SMS, every API request can come from the brand your client sees — because the data model was designed that way from line one.",
    },
  ],

  featureTable: {
    heading: "How LeadStack's base license compares to GoHighLevel's base plan",
    rows: [
      {
        label: "Unlimited sub-accounts",
        leadstack: true,
        competitor: false,
      },
      {
        label: "All-in-one CRM: contacts, pipeline, quotes, booking, calendar",
        leadstack: true,
        competitor: true,
      },
      {
        label: "AI Web Chat widget + SMS auto-reply + Voice agent",
        leadstack: true,
        competitor: false,
      },
      {
        label: "Google review requests (SMS + WhatsApp, auto + on-demand)",
        leadstack: true,
        competitor: true,
      },
      {
        label: "Premium support",
        leadstack: true,
        competitor: false,
      },
      {
        label: "Public API + webhooks included (idempotency, versioning)",
        leadstack: true,
        competitor: false,
      },
      {
        label: "Full source code access — modify any feature",
        leadstack: true,
        competitor: false,
      },
      {
        label: "Self-host on your own cloud account",
        leadstack: true,
        competitor: false,
      },
      {
        label: "Recurring monthly platform fee",
        leadstack: "$0",
        competitor: "$297/month",
      },
      {
        label: "Client data on your infrastructure",
        leadstack: true,
        competitor: false,
      },
      {
        label: "Per-sub-account dedicated email sending domain",
        leadstack: true,
        competitor: true,
      },
      {
        label: "Funnel / landing page builder",
        leadstack: true,
        competitor: true,
      },
    ],
  },

  pricing: {
    heading: "Pricing compared honestly",
    leadstack: {
      headline: "One-time license + your real vendor costs",
      detail:
        "Pay for LeadStack once. The features GoHighLevel sells as paid add-ons — AI Employee, premium support — and capabilities it gates behind higher tiers — the full public API + webhooks — are all included with the license. For most agencies, monthly running costs come in under the price of a cup of coffee — the free tiers across the underlying providers are generous.",
      notes: [
        "AI Employee equivalent (Web Chat + SMS + Voice agents): $0/month — included with the license.",
        "Public API + webhooks: $0 — included with the license (no tier gate).",
        "Premium support: $0/month — direct line to the team comes with the license.",
        "Cloud hosting — generous free tier covers low-volume deployments; ~$20/month for production agencies.",
        "Database + auth — generous free tier covers thousands of contacts; pay-as-you-grow thereafter.",
        "SMS + voice provider — per-number cost (~$1/month) plus per-message and per-minute rates billed to you at their published prices.",
        "Transactional email — free up to several thousand sends per month; ~$20/month at production volume.",
        "AI gateway — pay-per-token; cost per reply is negligible at typical reply volumes.",
      ],
    },
    competitor: {
      headline: "$297/month — and the add-ons stack fast",
      detail:
        "GoHighLevel's Unlimited Plan is $297/month or $2,970/year billed annually. The features most agencies actually need — AI Employee on every sub-account, premium support, white-label mobile app — are paid add-ons stacked on top of the base.",
      notes: [
        "12 months of GHL Unlimited base at $297/mo = $3,564.",
        "AI Employee: $97/month per sub-account — add-on, not included in the $297 base. At 10 sub-accounts that's another $970/month.",
        "Premium Support: $500/month flat — account-level add-on, not included in the $297 base.",
        "Public API + webhooks: gated to higher tiers — not on GoHighLevel's entry ($97) plan.",
        "After 5 years the base alone is roughly $17,820 — with no ownership accrual.",
        "Additional charges for other premium features (white-label mobile app, agency pro tools).",
        "SMS and voice credits are billed through GHL at a markup over the underlying provider's published rates.",
      ],
    },
    summary:
      "For a typical agency, break-even versus a single month of GoHighLevel lands inside the first month — not the first year. From month two onward, every dollar is pure savings, and the platform you sell to your clients is yours, not rented. Run the numbers below.",
  },

  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        question: "Is LeadStack a true GoHighLevel replacement?",
        answer:
          "For the core agency-CRM use cases — contacts, pipeline, calendar, booking pages, quotes, automations, bulk email broadcasts, AI Web Chat + SMS + Voice agents, Google review requests, dedicated per-sub-account phone numbers and sending domains, public REST API with webhooks — yes. LeadStack covers the surface area most agencies actually use day-to-day. For memberships, courses, or native mobile apps, GoHighLevel is currently more complete; those modules are on the LeadStack roadmap rather than shipped today.",
      },
      {
        question: "Can I migrate my clients from GoHighLevel to LeadStack?",
        answer:
          "Yes. Contacts move via a built-in CSV import; deals, tasks, and other records come across through the public REST API. Conversations, recorded voice calls, and historical automation execution logs are harder to extract from any platform — GoHighLevel is no exception. The realistic path most agencies take is: migrate new clients to LeadStack as they sign on, leave existing GHL clients in place until natural renewal, and run both side by side during the transition.",
      },
      {
        question: "How does the white-label work if LeadStack is self-hosted?",
        answer:
          "When you buy LeadStack, you clone the repository, deploy it to your own cloud account under your own domain, and edit the brand configuration file with your business name, tagline, support email, and pricing. The landing page, every dashboard surface, every transactional email, the public booking pages, the AI chat widget, the customer-facing quote pages — all render with your brand. The LeadStack name does not appear in the deployed product. Each agency sub-account you create can additionally be given its own sending domain and dedicated phone number so your clients see fully separated brands at the channel layer.",
      },
      {
        question: "What's the total cost of ownership over 12 months?",
        answer:
          "After the one-time license, typical first-year vendor spend for a small agency running 3–10 sub-accounts lands between $30 and $200 per month depending on SMS volume, email volume, and AI usage. Compare to GoHighLevel Unlimited at $297/month flat: even an active LeadStack deployment at the upper end is significantly cheaper, and most of that spend is pass-through to your communications and AI providers at their published rates rather than a platform markup.",
      },
      {
        question: "Who owns my client data with LeadStack?",
        answer:
          "You do, in the strictest sense. The database storing contacts, deals, conversations, voice call summaries, and every other artifact is in your own cloud project, under your billing account, under your access control. There is no LeadStack-controlled database in the loop. If you wanted to walk away from the LeadStack codebase tomorrow and run the deployment indefinitely without us, the deployment would continue to function — and you can export the full database at any time using the standard export tooling your database vendor provides.",
      },
      {
        question: "What about the GoHighLevel features LeadStack doesn't have yet?",
        answer:
          "We're transparent about gaps: memberships and courses, native mobile apps, and a native drag-and-drop funnel builder are present in GoHighLevel today and on the LeadStack roadmap rather than shipped. The two strategic responses: (1) most agencies don't use every GHL module — review which features you actually charge clients for before assuming you need parity; (2) because LeadStack is a codebase you own, you can ship missing features yourself, contract a developer to do so, or wait for the roadmap. With GHL, the only option is wait for their roadmap.",
      },
      {
        question: "Do I need to be a developer to run LeadStack?",
        answer:
          "Setting LeadStack up requires a one-time configuration step where you create accounts at a small number of standard service providers (cloud hosting + database, payments, email, SMS, and a handful of optional services), then paste API keys into an environment file. The repository ships a step-by-step onboarding guide written for non-developers, and most buyers finish the setup with help from an AI coding assistant in under an hour. Day-to-day operation requires no code — the entire CRM is browser-based once deployed.",
      },
      {
        question: "What happens if LeadStack stops being maintained?",
        answer:
          "Your deployment keeps running. Unlike a SaaS where the product stops the day the company does, LeadStack is code you own. Worst case, you continue running the version you have. More practically, the codebase is built on widely-used open-source frameworks and managed cloud services, so you or any competent developer can maintain and extend it long after any individual vendor's involvement ends.",
      },
    ],
  },

  finalCta: {
    headline: "Own your CRM. Stop renting it.",
    body: "LeadStack gives agencies the full GoHighLevel-style surface area as code they own, on infrastructure they control, with no recurring platform fee on top.",
    primaryCtaLabel: "See LeadStack pricing",
    primaryCtaHref: "/#pricing",
  },
};
