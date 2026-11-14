/**
 * 404gen (Bittensor SN17) ServiceAdapter: a batch 3D-generation reference adapter,
 * built to the pattern the shipped Gradients (SN56) adapter established. A
 * Worker Bot wraps the 404gen text-to-3D subnet behind the `ServiceAdapter` interface:
 * it swaps a per-task USDC budget into TAO internally, pays subnet miners in TAO to
 * generate a batch of 3D assets, collects the batch deliverable, and returns a
 * currency-free `ServiceResult`. The Buyer and the escrow contract only ever see USDC;
 * no TAO-typed value crosses this boundary into SDK core (the branded `Tao` type of
 * ../bittensor/index.ts keeps it out at compile time for the Bittensor trio).
 *
 * The swap, subnet call, and pinning are injectable ports so the reference runs (and
 * is tested) without a live DEX, subnet, or IPFS node. A production worker supplies
 * real implementations (Jupiter for the swap, the SN17 dendrite, Pinata/Arweave).
 *
 * RELEASE JUDGMENT IS NOT HERE. This adapter only PRODUCES the deliverable (a batch of
 * 3D assets, each with a declared container format and polygon count). Whether the batch
 * is acceptable is decided by the BUYER's review.ts. For the canned demo the buyer knows
 * the exact expected artifact (the eval-threshold review re-verifies the fetched
 * deliverable hashes to the submitted contentHash) and additionally gates on the declared
 * per-asset descriptors via `score404genDemoDeliverable` (format, polygon range, batch
 * completeness). That recompute reads the DECLARED descriptors, not the asset bytes: a
 * production 404gen buyer generating novel assets must derive the container from the
 * fetched asset's magic bytes and the polygon count from its parsed geometry before
 * releasing. The worker never scores-for-release and never releases: the buyer is the judge.
 *
 * The USDC->TAO port skeleton and the execute shape are shared with the other Bittensor
 * adapters via `../bittensor/index.js`; this module supplies only its subnet identity,
 * capabilities, budget, and demo logic.
 */
import { canonicalize, type TaskSpec } from "@escro/shared";

import type { ServiceAdapter } from "../../adapter.js";
import {
  createBittensorSubnetAdapter,
  defaultPin,
  defaultSwap,
  type PinContent,
  type SubnetCall,
  type UsdcToTaoSwap,
} from "../bittensor/index.js";

/** Configuration and injectable ports for {@link create404genAdapter}. */
export interface Gen404AdapterConfig {
  /** Subnet identifier. Defaults to "sn17" (404gen); forms the adapter id `bittensor:<subnet>`. */
  subnet?: string;
  /** Advertised capabilities for EscroBots discovery. Defaults to `["3d-generation"]`. */
  capabilities?: string[];
  /** μUSDC the worker allocates to a single task before converting to TAO (internal budgeting). */
  taskBudgetMicroUsdc?: number;
  /** Swap port. Default: a fixed-rate reference stub. */
  swap?: UsdcToTaoSwap;
  /** Subnet-call port. Default: solves the canned demo job; a deterministic placeholder otherwise. */
  callSubnet?: SubnetCall;
  /** Pinning port. Default: a deterministic `ipfs://` placeholder URI. */
  pin?: PinContent;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

/** Stable id/capabilities, to be locked against `ADAPTER_DESCRIPTORS["404gen"]` by a kit test at merge. */
export const GEN404_ADAPTER_ID = "bittensor:sn17";
export const GEN404_CAPABILITIES = ["3d-generation"] as const;

const DEFAULT_SUBNET = "sn17";
const DEFAULT_TASK_BUDGET_MICRO_USDC = 5_000_000;

// ---------------------------------------------------------------------------
// Canned demo job: a deterministic batch 3D job the buyer
// template's 5-minute journey hires this bot for. The batch requests one asset with
// a machine-checkable format + polygon-count contract. Acceptance is recomputed by
// the BUYER (see score404genDemoDeliverable): each declared asset's format must be an
// allowed container, its declared polygon count must fall in range, and the batch must
// be complete. Any self-reported eval score is ignored (a production buyer parses the
// actual asset geometry - see the module note).
// ---------------------------------------------------------------------------

/** Stable marker on the demo spec's metadata so the default subnet stub recognizes it. */
export const GEN404_DEMO_MARKER = "404gen-sn17-demo-v1";

/** The demo eval floor: the batch must be complete and every asset valid (score 1). */
export const GEN404_DEMO_EVAL_FLOOR = 1;

/** The demo batch contract: what the buyer independently checks each asset against. */
interface BatchExpectation {
  /** Number of assets the batch must contain to be complete. */
  requestedAssets: number;
  /** Container formats the buyer accepts (compared case-insensitively). */
  allowedFormats: readonly string[];
  /** Inclusive polygon-count bounds a valid asset must fall within. */
  minPolygons: number;
  maxPolygons: number;
}

const DEMO_EXPECTATION: BatchExpectation = {
  requestedAssets: 1,
  allowedFormats: ["GLB", "PLY"],
  minPolygons: 1_000,
  maxPolygons: 1_000_000,
};

/**
 * The canned 404gen demo job. Deterministic; its specHash is pinned by a test
 * because the buyer journey depends on hash stability.
 */
export const gen404DemoJobSpec: TaskSpec = {
  version: "1.0.0",
  // TaskType has no 3D category; "custom" is the canonical fallback.
  taskType: "custom",
  description:
    "Generate the canned SN17 demo batch: one 3D asset in a GLB or PLY container with a " +
    "polygon count between 1000 and 1000000. Acceptance is deterministic and recomputed " +
    "by the buyer: every requested asset must be present, in an allowed format, and in " +
    "polygon range; the worker's self-reported validity is not trusted.",
  acceptanceCriteria: [
    {
      id: "ac-format-valid",
      description:
        "Every asset is in an allowed container format (GLB or PLY), recomputed by the buyer.",
      required: true,
    },
    {
      id: "ac-polygon-range",
      description:
        "Every asset's polygon count is within [1000, 1000000], recomputed by the buyer.",
      required: true,
    },
    {
      id: "ac-batch-complete",
      description:
        "The batch contains all requested assets (completeness), recomputed by the buyer.",
      required: true,
    },
  ],
  deliverableFormat: { type: "json" },
  metadata: {
    demo: GEN404_DEMO_MARKER,
    requestedAssets: DEMO_EXPECTATION.requestedAssets,
    allowedFormats: [...DEMO_EXPECTATION.allowedFormats],
    minPolygons: DEMO_EXPECTATION.minPolygons,
    maxPolygons: DEMO_EXPECTATION.maxPolygons,
  },
};

/**
 * The reference solution to the demo job: a complete batch of valid assets plus a
 * (self-reported, buyer-ignored) eval block, as canonical JSON. Deterministic.
 * Exposed so the demo journey and tests share one source of the expected artifact.
 */
export function solveGen404Demo(): string {
  return canonicalize({
    assets: [{ format: "GLB", polygonCount: 5_000, uri: "ipfs://404gen-sn17-demo-asset-0" }],
    eval: { metric: "validity", score: 1 },
  });
}

interface DemoAsset {
  format: string;
  polygonCount: number;
}

interface DemoBatch {
  assets: DemoAsset[];
}

function parseBatch(content: string | Buffer): DemoBatch | null {
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
  const assets = (parsed as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) {
    return null;
  }
  const cleaned: DemoAsset[] = [];
  for (const asset of assets) {
    if (typeof asset !== "object" || asset === null) {
      return null;
    }
    const format = (asset as { format?: unknown }).format;
    const polygonCount = (asset as { polygonCount?: unknown }).polygonCount;
    if (typeof format !== "string" || typeof polygonCount !== "number") {
      return null;
    }
    cleaned.push({ format, polygonCount });
  }
  return { assets: cleaned };
}

function isAssetValid(asset: DemoAsset): boolean {
  const formatOk = DEMO_EXPECTATION.allowedFormats.some(
    (f) => f.toLowerCase() === asset.format.toLowerCase(),
  );
  const rangeOk =
    asset.polygonCount >= DEMO_EXPECTATION.minPolygons &&
    asset.polygonCount <= DEMO_EXPECTATION.maxPolygons;
  return formatOk && rangeOk;
}

/**
 * The BUYER's recompute of the demo batch score in [0, 1] over the deliverable's
 * DECLARED per-asset descriptors. Every delivered asset must pass the format and
 * polygon-range checks (any single invalid asset scores 0, so a well-formed but junk
 * extra cannot slip through), and the batch must contain at least the requested count
 * (completeness); a short batch scores the filled fraction. Any self-reported `eval`
 * score in the deliverable is ignored. Malformed or unparseable content scores 0 and
 * never throws.
 *
 * NOTE: this gates the deliverable's declared `format`/`polygonCount` fields, not the
 * asset bytes. For the deterministic canned demo that is sufficient because the buyer
 * additionally knows the exact expected artifact (the eval-threshold review re-verifies
 * the fetched deliverable hashes to the submitted contentHash). A production 404gen
 * buyer generating NOVEL assets must derive the container from the fetched asset's magic
 * bytes and the polygon count from its parsed geometry before releasing (kit-docs debt).
 */
export function score404genDemoDeliverable(content: string | Buffer): number {
  const batch = parseBatch(content);
  if (batch === null) {
    return 0;
  }
  if (batch.assets.some((asset) => !isAssetValid(asset))) {
    return 0;
  }
  return Math.min(batch.assets.length / DEMO_EXPECTATION.requestedAssets, 1);
}

// A generic (non-demo) batch produces a placeholder asset so a fresh worker returns a
// well-formed ServiceResult before a real SN17 miner is wired.
function referencePlaceholder(spec: TaskSpec): string {
  return canonicalize({
    assets: [{ format: "GLB", polygonCount: 0, uri: "ipfs://placeholder" }],
    note: "reference stub - replace the callSubnet port with a real SN17 miner call.",
    taskType: spec.taskType,
  });
}

const defaultCallSubnet: SubnetCall = (spec) =>
  Promise.resolve(
    spec.metadata.demo === GEN404_DEMO_MARKER ? solveGen404Demo() : referencePlaceholder(spec),
  );

/**
 * Build a 404gen (SN17) {@link ServiceAdapter}. Passes `assertServiceAdapterContract`
 * with the default ports; supply real ports for production use. The USDC->TAO swap,
 * pinning, and execute skeleton come from the shared Bittensor core.
 */
export function create404genAdapter(config: Gen404AdapterConfig = {}): ServiceAdapter {
  return createBittensorSubnetAdapter({
    subnet: config.subnet ?? DEFAULT_SUBNET,
    capabilities: config.capabilities ?? [...GEN404_CAPABILITIES],
    taskBudgetMicroUsdc: config.taskBudgetMicroUsdc ?? DEFAULT_TASK_BUDGET_MICRO_USDC,
    swap: config.swap ?? defaultSwap,
    callSubnet: config.callSubnet ?? defaultCallSubnet,
    pin: config.pin ?? defaultPin,
    checkHealth: config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true)),
  });
}
