import { z } from "zod";
import { RAILS, ENABLED_RAILS, RAILS_DOCS_URL, MIN_ESCROW_AMOUNT } from "@escro/sdk";
import { StorageConfigSchema } from "./src/storage.js";
import { ADAPTER_IDS } from "./escro.types.js";
import { usdcToMicro } from "./src/float-cap.js";

/** The seconds a facilitator's verify and settle take out of an `exact` answer's window. */
const EXACT_SETTLE_MARGIN_SECONDS = 15;

/** An https: URL with no username, password, query or fragment: a key in it would sit in this committed file. */
function isPlainHttpsUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    !url.href.includes("?") &&
    !url.href.includes("#")
  );
}

// A route's direct `exact` price beside its escrow price: the buyer pays the worker's wallet
// through the facilitator and gets the answer in the same request. For quick work only: the
// answer is due within `maxTimeoutSeconds`, which must cover estimatedDurationSeconds plus 15 s.
const ExactLegSchema = z.object({
  // No escrow minimum applies.
  priceUsdc: z
    .number()
    .finite()
    .positive()
    // Zod runs a refinement after a failed check too; the checks above own a non-positive price.
    .refine(
      (usdc) => !(Number.isFinite(usdc) && usdc > 0) || usdcToMicro(usdc) >= 1,
      "exact.priceUsdc is under one micro-USDC.",
    ),
  maxTimeoutSeconds: z.number().int().min(10).max(3600).default(120),
});

// What a route declares to a discovery catalog (PayAI, the CDP Bazaar), which lists it once an
// exact payment to it settles. `input` is the JSON body the catalog POSTs to probe the route, so
// taskSpecFor must accept it; `output` is an example answer. The menu enforces the rest at start.
const DiscoverySchema = z.object({
  description: z.string().min(1).max(500),
  input: z.record(z.unknown()),
  output: z.object({ type: z.string().min(1), example: z.unknown() }).optional(),
});

/** An https: URL whose path does not end .svg or .svgz: the catalogs list JPG, PNG, WebP and GIF icons. */
function isListableIconUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const path = url.pathname.toLowerCase();
  return url.protocol === "https:" && !path.endsWith(".svg") && !path.endsWith(".svgz");
}

// An HTTP 402 menu beside the polling loop. Named so it is not confused with the reserved
// buyer-side `x402` rail below. Off by default: with it off the bot opens no port. Enabled, it
// needs an https `publicUrl` and at least one route priced at the minimum escrow or more.
const Serve402Schema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8402),
    // Your server's public https origin (scheme, host and optional port, no path), the URL buyers
    // are told to pay and poll. Terminate TLS at a proxy in front of `host`:`port`.
    publicUrl: z.string().url().optional(),
    // The facilitator that settles the routes' `exact` prices, required when a route sets one:
    // https, no key in it. A facilitator URL carrying a key does not belong in this committed file.
    facilitatorUrl: z.string().optional(),
    routes: z
      .array(
        z.object({
          capability: z.string().regex(/^[a-z0-9_-]{1,64}$/),
          priceUsdc: z.number().finite().nonnegative(),
          exact: ExactLegSchema.optional(),
          discovery: DiscoverySchema.optional(),
        }),
      )
      .default([]),
    // The service a catalog lists the routes under: a name, up to five tags and an icon.
    serviceName: z.string().optional(),
    tags: z.array(z.string()).optional(),
    iconUrl: z.string().optional(),
  })
  .superRefine((serve, ctx) => {
    const exact = serve.routes.some((route) => route.exact !== undefined);
    if (
      (exact || serve.facilitatorUrl !== undefined) &&
      (serve.facilitatorUrl === undefined || !isPlainHttpsUrl(serve.facilitatorUrl))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facilitatorUrl"],
        message:
          "serve402.facilitatorUrl must be an https: URL with no username, password, query or fragment when a route sets exact.",
      });
    }
    if (serve.iconUrl !== undefined && !isListableIconUrl(serve.iconUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["iconUrl"],
        message:
          "serve402.iconUrl must be an https: URL whose path does not end .svg or .svgz (catalogs list JPG, PNG, WebP and GIF icons).",
      });
    }
    serve.routes.forEach((route, index) => {
      if (route.discovery !== undefined && route.exact === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routes", index, "discovery"],
          message: `serve402 route "${route.capability}" declares discovery with no exact price: a catalog lists a route only after an exact payment to it settles.`,
        });
      }
    });
    if (!serve.enabled) return;
    if (
      serve.publicUrl === undefined ||
      !URL.canParse(serve.publicUrl) ||
      new URL(serve.publicUrl).protocol !== "https:"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publicUrl"],
        message: "serve402.publicUrl must be an https: URL when the menu is enabled.",
      });
    }
    if (serve.routes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routes"],
        message: "serve402.routes needs at least one route when the menu is enabled.",
      });
    }
    const seen = new Set<string>();
    serve.routes.forEach((route, index) => {
      if (usdcToMicro(route.priceUsdc) < MIN_ESCROW_AMOUNT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routes", index, "priceUsdc"],
          message: `serve402 route "${route.capability}" is priced under the ${String(MIN_ESCROW_AMOUNT / 1_000_000)} USDC minimum escrow.`,
        });
      }
      if (seen.has(route.capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routes", index, "capability"],
          message: `serve402 route "${route.capability}" is listed twice.`,
        });
      }
      seen.add(route.capability);
    });
  });

// The scaffolder rewrites the name / network / adapter literals below.
// `network` defaults to devnet; mainnet requires the deliberate opt-in flag.
//
// Validation runs at import, so a misconfigured bot fails loudly at START, never
// mid-job; a setting not filled in yet (storage.endpoint, storage.publicBase) idles
// instead, naming it. Tune the working-capital and timing knobs to your adapter.
// Exported so tests can assert the schema's guarantees (e.g. the float bound is
// required, never silently defaulted to something unbounded).
export const ConfigSchema = z
  .object({
    name: z.string().min(1),
    network: z.enum(["devnet", "mainnet"]),
    template: z.literal("worker"),
    adapter: z.enum(ADAPTER_IDS),
    // The rails this bot may use: `escrow` (the default) and `x402`. The check reads
    // @escro/sdk's ENABLED_RAILS, so a rail the SDK does not enable fails config load.
    rails: z
      .array(z.enum(RAILS))
      .default(["escrow"])
      .superRefine((rails, ctx) => {
        for (const rail of rails) {
          if (!ENABLED_RAILS.includes(rail)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["rails"],
              message: `Payment rail "${rail}" is not enabled in this @escro/sdk. Enabled: ${ENABLED_RAILS.join(", ")}. Remove it from "rails". See ${RAILS_DOCS_URL}`,
            });
          }
        }
      }),
    // Working capital you are willing to tie up across concurrent jobs, in USDC.
    // REQUIRED, and there is deliberately NO unbounded default: the bot refuses to
    // claim a job when its in-flight service costs would exceed this bound. Workers
    // front the service cost and are only reimbursed in USDC when the buyer releases.
    maxConcurrentFloatUsdc: z.number().positive(),
    // Typical service cost you front per job (USDC) and typical job duration (s).
    // These drive the float guard and the "never claim what I can't finish" guard.
    estimatedServiceCostUsdc: z.number().nonnegative(),
    estimatedDurationSeconds: z.number().positive(),
    // Refuse a job unless at least this much margin remains before its deadline.
    deadlineSafetyBufferSeconds: z.number().nonnegative(),
    // Deliverable storage. Deliverables are dispute evidence: retention is >= 90 days.
    storage: StorageConfigSchema,
    // Anonymous time-to-first-escrow funnel events (stage names + durations only; no wallet, no task
    // content). Opt out here or scaffold with --no-telemetry. See src/telemetry.ts.
    telemetry: z.boolean().default(true),
    serve402: Serve402Schema.default({ enabled: false, routes: [] }),
  })
  .superRefine((config, ctx) => {
    if (!config.serve402.enabled) return;
    const due = config.estimatedDurationSeconds + EXACT_SETTLE_MARGIN_SECONDS;
    config.serve402.routes.forEach((route, index) => {
      if (route.exact !== undefined && route.exact.maxTimeoutSeconds < due) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["serve402", "routes", index, "exact", "maxTimeoutSeconds"],
          message: `serve402 route "${route.capability}" answers exact payments within ${String(route.exact.maxTimeoutSeconds)} s, under estimatedDurationSeconds plus the ${String(EXACT_SETTLE_MARGIN_SECONDS)} s the facilitator's verify and settle take.`,
        });
      }
    });
  });

export type EscroConfig = z.infer<typeof ConfigSchema>;

const config: EscroConfig = ConfigSchema.parse({
  name: "my-bot",
  network: "devnet",
  template: "worker",
  adapter: "custom",
  rails: ["escrow"],
  maxConcurrentFloatUsdc: 100,
  estimatedServiceCostUsdc: 10,
  estimatedDurationSeconds: 300,
  deadlineSafetyBufferSeconds: 120,
  storage: {
    backend: "s3-presigned",
    retentionDays: 90,
    // endpoint: your presign service, minting a PUT URL per deliverable key (ipfs: a pinning
    // endpoint); publicBase: the URL prefix buyers read deliverables from. src/storage.ts
    // describes both backends.
    // endpoint: "https://your-backend.example/deliverables/presign",
    // publicBase: "https://your-bucket.s3.eu-west-1.amazonaws.com/deliverables/",
  },
  telemetry: true,
  // Serve a 402 menu beside the loop: set enabled, publicUrl and at least one
  // { capability, priceUsdc } route (the serve402 block above describes each setting).
  // A route may also take a direct exact price, settled through a facilitator, and describe
  // itself to a discovery catalog, with the service's name, tags and icon, for example:
  //   facilitatorUrl: "https://facilitator.payai.network",
  //   routes: [{ capability: "summarise", priceUsdc: 5, exact: { priceUsdc: 0.05, maxTimeoutSeconds: 330 },
  //   discovery: { description: "Summarises a document posted as JSON.", input: { text: "An example document." },
  //   output: { type: "json", example: { summary: "An example summary." } } } }],
  //   serviceName: "Example summarizer", tags: ["summarize"], iconUrl: "https://worker.example.com/icon.png",
  // exact.maxTimeoutSeconds must cover estimatedDurationSeconds plus 15 s (330 for the 300 above).
  // discovery.input is the body the catalog posts to probe the route: taskSpecFor must accept it.
  serve402: { enabled: false, routes: [] },
});

export default config;
