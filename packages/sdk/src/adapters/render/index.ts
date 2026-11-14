/**
 * Render Network ServiceAdapter: a SHIPPED, supported adapter for decentralized GPU
 * rendering (3D scenes, video frames, diffusion/inference jobs). A Worker Bot wraps a
 * Render Network job behind the `ServiceAdapter` interface: it swaps a per-task USDC
 * budget into RENDER internally, pays for the render job in RENDER, collects the
 * rendered output artifact, and returns a currency-free `ServiceResult`. The Buyer and
 * the escrow contract only ever see USDC; no RENDER-typed value crosses this boundary
 * into SDK core (the branded `Render` type keeps it out at compile time).
 *
 * Render is Solana-native with MINIMAL BRIDGING: RENDER is a Solana SPL token, so the
 * USDC->RENDER conversion is a same-chain DEX swap (e.g. Jupiter) with no cross-chain
 * bridge. This is the distinction from the Bittensor trio (gradients SN56, 404gen SN17,
 * lium SN51), whose TAO must be bridged off Solana to Bittensor. Because its token and
 * network differ, Render carries its own branded `Render` type and its own execute
 * skeleton and is deliberately NOT part of the shared `adapters/bittensor` core.
 *
 * No price feed lives in SDK core: the USDC->RENDER rate is an injectable `swap` port
 * defaulting to a deterministic fixed reference rate (see `defaultSwap`). A production
 * worker injects a real DEX route; SDK core embeds no live price feed. The swap,
 * render-job call, and pinning are injectable ports so the reference runs (and is
 * tested) without a live DEX, Render Network endpoint, or IPFS node.
 *
 * RELEASE JUDGMENT IS NOT HERE. This adapter only PRODUCES the deliverable (the rendered
 * frame). Whether the render is acceptable is decided by the BUYER's review.ts, which
 * independently RE-RENDERS the scripted demo scene and compares the substantive frame
 * (see `scoreRenderDemoDeliverable`). The worker never scores-for-release and never
 * releases, and its self-reported `frameHash` is never trusted: the buyer is the judge.
 */
import { createHash } from "crypto";

import { canonicalize, type TaskSpec } from "@escro/shared";

import type { ServiceAdapter, ServiceResult } from "../../adapter.js";

/**
 * Amount denominated in RENDER (Render Network's Solana SPL token). Branded so it cannot
 * be assigned to or from a plain `number` by accident and (the point of the brand) so it
 * can never appear in a `ServiceResult` or the escrow submit path: those types have no
 * field of this type. RENDER exists ONLY inside this adapter module.
 */
export type Render = number & { readonly __brand: "RENDER" };

/** Construct a {@link Render} amount from a plain number. Adapter-internal use only. */
export function renderAmount(amount: number): Render {
  return amount as Render;
}

/** Swap a microUSDC budget into RENDER. Real workers route this through a Solana DEX (e.g. Jupiter). */
export type UsdcToRenderSwap = (microUsdc: number) => Promise<Render>;

/** Submit `spec`'s render job funded with `budget` RENDER; resolve with the raw rendered artifact. */
export type RunRenderJob = (spec: TaskSpec, budget: Render) => Promise<string | Buffer>;

/** Pin `content` and resolve with a content-addressed proof URI (ipfs://, ar://). */
export type PinContent = (content: string | Buffer) => Promise<string>;

/** Configuration and injectable ports for {@link createRenderAdapter}. */
export interface RenderAdapterConfig {
  /** Service identifier. Defaults to "render"; forms the adapter id. */
  service?: string;
  /** Advertised capabilities for EscroBots discovery. Defaults to {@link RENDER_CAPABILITIES}. */
  capabilities?: string[];
  /** microUSDC the worker allocates to a single task before converting to RENDER (internal budgeting). */
  taskBudgetMicroUsdc?: number;
  /** Swap port. Default: a fixed-rate reference stub (no live price feed). */
  swap?: UsdcToRenderSwap;
  /** Render-job port. Default: renders the canned demo scene; a deterministic placeholder otherwise. */
  runJob?: RunRenderJob;
  /** Pinning port. Default: a deterministic `ipfs://` placeholder URI. */
  pin?: PinContent;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

// Stable id/capabilities. The adapter's own tests pin its runtime output to these
// constants; at merge the main-owned kit seam test cross-checks them against the
// registry descriptor (ADAPTER_DESCRIPTORS.render) so the descriptor and the shipped
// adapter cannot drift apart (coordinated with the capability taxonomy).
export const RENDER_ADAPTER_ID = "render";
export const RENDER_CAPABILITIES = ["3d-rendering", "video-rendering", "gpu-inference"] as const;

const DEFAULT_SERVICE = "render";
const DEFAULT_TASK_BUDGET_MICRO_USDC = 15_000_000;

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// Nominal reference rate: microUSDC -> RENDER. Only the stub swap cares about the exact
// value; a production worker injects a real DEX route via the `swap` port.
export const REFERENCE_MICRO_USDC_PER_RENDER = 2_000_000;

/** Default fixed-rate reference swap: a pure function of its input, no live price feed. */
export const defaultSwap: UsdcToRenderSwap = (microUsdc) =>
  Promise.resolve(renderAmount(microUsdc / REFERENCE_MICRO_USDC_PER_RENDER));

/** Default deterministic `ipfs://` placeholder pin. */
export const defaultPin: PinContent = (content) =>
  Promise.resolve(`ipfs://placeholder-${sha256Hex(content).slice(0, 16)}`);

// ---------------------------------------------------------------------------
// Canned demo job: a 5-minute scripted render job the buyer
// template's journey hires this bot for. The "render" is a deterministic procedural
// raster (a fixed shader over a fixed-size frame), so its output artifact is
// reproducible: the buyer RE-RENDERS it independently (see scoreRenderDemoDeliverable)
// and releases only when the job completed, a frame is present, and the frame matches.
// The worker's self-reported frameHash is never trusted.
// ---------------------------------------------------------------------------

/** Stable marker on the demo spec's metadata so the default job stub recognizes it. */
export const RENDER_DEMO_MARKER = "render-demo-v1";

/** The demo accept floor: frame-match is exact, so the buyer requires a full match. */
export const RENDER_DEMO_ACCEPT_FLOOR = 1;

const DEMO_SCENE = "render-demo-scene-v1";
const DEMO_WIDTH = 16;
const DEMO_HEIGHT = 16;

/**
 * The deterministic per-pixel shader for the demo scene: a fixed grayscale value in
 * [0, 255] for pixel (x, y). Pure and reproducible, so the buyer can re-render and
 * compare independently.
 */
function shade(x: number, y: number): number {
  return (x * 53 + y * 97 + (x ^ y) * 29) & 0xff;
}

/**
 * Render the fixed demo scene into a grayscale raster and return its hex encoding.
 * Deterministic and cheap to recompute, so the buyer verifies the frame independently.
 */
export function computeRenderDemoArtifact(): string {
  const raster = Buffer.alloc(DEMO_WIDTH * DEMO_HEIGHT);
  let i = 0;
  for (let y = 0; y < DEMO_HEIGHT; y++) {
    for (let x = 0; x < DEMO_WIDTH; x++) {
      raster[i++] = shade(x, y);
    }
  }
  return raster.toString("hex");
}

/**
 * The canned Render demo job. Deterministic; its specHash is pinned by a test because
 * the buyer journey depends on hash stability.
 */
export const renderDemoJobSpec: TaskSpec = {
  version: "1.0.0",
  taskType: "image_generation",
  description:
    "Render the canned demo scene (a fixed procedural frame) and return the rendered " +
    "frame. Acceptance is deterministic and recomputed by the buyer: the job must " +
    "complete, a rendered frame must be present, and the frame must match the buyer's " +
    "independent re-render; the worker's self-reported frame hash is not trusted.",
  acceptanceCriteria: [
    {
      id: "ac-completion",
      description: "The render job ran to completion (status=completed).",
      required: true,
    },
    {
      id: "ac-frame-present",
      description: "A rendered frame is present in the deliverable.",
      required: true,
    },
    {
      id: "ac-frame-match",
      description: "The rendered frame matches the buyer's independent re-render of the scene.",
      required: true,
    },
  ],
  deliverableFormat: { type: "json" },
  metadata: {
    demo: RENDER_DEMO_MARKER,
    scene: DEMO_SCENE,
    width: DEMO_WIDTH,
    height: DEMO_HEIGHT,
    acceptFloor: RENDER_DEMO_ACCEPT_FLOOR,
  },
};

/**
 * The reference solution to the demo job: the completed job report carrying the correct
 * rendered frame plus a (self-reported, buyer-ignored) frameHash, as canonical JSON.
 * Deterministic. Exposed so the demo journey and tests share one source of the expected
 * artifact.
 */
export function solveRenderDemo(): string {
  const frame = computeRenderDemoArtifact();
  return canonicalize({
    job: RENDER_DEMO_MARKER,
    status: "completed",
    width: DEMO_WIDTH,
    height: DEMO_HEIGHT,
    frame,
    // Self-reported and deliberately ignored by the buyer's recompute.
    frameHash: sha256Hex(frame),
  });
}

interface DemoDeliverable {
  status: string;
  frame: string | null;
}

function parseDemoDeliverable(content: string | Buffer): DemoDeliverable | null {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as { status?: unknown; frame?: unknown };
  const status = typeof obj.status === "string" ? obj.status : "";
  const frame = typeof obj.frame === "string" ? obj.frame : null;
  return { status, frame };
}

/**
 * The BUYER's independent recompute of the demo acceptance predicate, returning 1 when
 * the deliverable satisfies all three criteria and 0 otherwise. It checks completion
 * (status), frame presence, and a frame match by RE-RENDERING the scripted scene and
 * comparing the substantive frame; it deliberately IGNORES any self-reported
 * `frameHash`, so release can never be worker-controlled. Malformed or
 * unparseable content scores 0 and never throws.
 */
export function scoreRenderDemoDeliverable(content: string | Buffer): number {
  const parsed = parseDemoDeliverable(content);
  if (parsed === null) {
    return 0;
  }
  if (parsed.status !== "completed") {
    return 0;
  }
  if (parsed.frame === null) {
    return 0;
  }
  return parsed.frame === computeRenderDemoArtifact() ? 1 : 0;
}

// A generic (non-demo) render job produces a placeholder completion report so a fresh
// worker returns a well-formed ServiceResult before a real Render Network job is wired.
function referencePlaceholder(spec: TaskSpec): string {
  return canonicalize({
    job: "render-generic",
    status: "completed",
    frame: null,
    note: "reference stub - replace the runJob port with a real Render Network job submission.",
    taskType: spec.taskType,
  });
}

const defaultRunJob: RunRenderJob = (spec) =>
  Promise.resolve(
    spec.metadata.demo === RENDER_DEMO_MARKER ? solveRenderDemo() : referencePlaceholder(spec),
  );

/**
 * Build a Render {@link ServiceAdapter}. Passes `assertServiceAdapterContract` with the
 * default ports; supply real ports for production use. The execute skeleton: swap the
 * USDC budget into RENDER (internal, same-chain, never surfaced), pay the render job in
 * RENDER and collect the frame, then hash and pin. The recorded `ServiceResult` is
 * currency-free (no RENDER field).
 */
export function createRenderAdapter(config: RenderAdapterConfig = {}): ServiceAdapter {
  const service = config.service ?? DEFAULT_SERVICE;
  const capabilities = config.capabilities ?? [...RENDER_CAPABILITIES];
  const taskBudgetMicroUsdc = config.taskBudgetMicroUsdc ?? DEFAULT_TASK_BUDGET_MICRO_USDC;
  const swap = config.swap ?? defaultSwap;
  const runJob = config.runJob ?? defaultRunJob;
  const pin = config.pin ?? defaultPin;
  const checkHealth = config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true));

  return {
    id: service,
    capabilities,
    healthCheck: checkHealth,
    async execute(spec: TaskSpec): Promise<ServiceResult> {
      // 1. Swap the USDC budget into RENDER (internal, same-chain DEX; no bridge).
      const budgetRender = await swap(taskBudgetMicroUsdc);
      // 2. Pay for the render job in RENDER and collect the rendered frame.
      const content = await runJob(spec, budgetRender);
      // 3. Hash and pin. The result the escrow records is currency-free.
      const contentHash = sha256Hex(content);
      const proofUri = await pin(content);
      return {
        content,
        contentHash,
        proofUri,
        metadata: { adapter: service, network: "render" },
      };
    },
  };
}
