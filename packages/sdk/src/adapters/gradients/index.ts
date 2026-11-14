/**
 * Gradients (Bittensor SN56) ServiceAdapter: the first SHIPPED, supported adapter
 * (the reference pattern the other subnet adapters replicate). A Worker Bot wraps the Gradients
 * fine-tuning subnet behind the `ServiceAdapter` interface: it swaps a per-task
 * USDC budget into TAO internally, pays subnet miners in TAO to fine-tune, collects
 * a checkpoint + eval deliverable, and returns a currency-free `ServiceResult`. The
 * Buyer and the escrow contract only ever see USDC; no TAO-typed value crosses this
 * boundary into SDK core (the branded `Tao` type of ../bittensor/index.ts keeps it out
 * at compile time for the Bittensor trio).
 *
 * The swap, subnet call, and pinning are injectable ports so the reference runs (and
 * is tested) without a live DEX, subnet, or IPFS node. A production worker supplies
 * real implementations (Jupiter for the swap, the SN56 dendrite, Pinata/Arweave).
 *
 * RELEASE JUDGMENT IS NOT HERE. This adapter only PRODUCES the deliverable (checkpoint
 * + eval JSON). Whether the eval clears the threshold is decided by the BUYER's
 * review.ts, which independently recomputes the score (see `scoreGradientsDemoDeliverable`).
 * The worker never scores-for-release and never releases: the buyer is the judge.
 *
 * Relationship to `examples/worker-bot/bittensor-adapter.ts`: that example is
 * pedagogy ("author your own adapter against the public interface", driven by e2e
 * scenario 13); THIS module is the shipped, importable
 * surface a generated bot uses. The USDC->TAO port skeleton and the execute shape are
 * shared with the other Bittensor adapters via `../bittensor/index.js`; this module
 * supplies only its subnet identity, capabilities, budget, and demo logic.
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

/** Configuration and injectable ports for {@link createGradientsAdapter}. */
export interface GradientsAdapterConfig {
  /** Subnet identifier. Defaults to "sn56" (Gradients); forms the adapter id `bittensor:<subnet>`. */
  subnet?: string;
  /** Advertised capabilities for EscroBots discovery. Defaults to `["fine-tune"]`. */
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

/** Stable id/capabilities, LOCKED against `ADAPTER_DESCRIPTORS.gradients` by a kit test. */
export const GRADIENTS_ADAPTER_ID = "bittensor:sn56";
export const GRADIENTS_CAPABILITIES = ["fine-tune"] as const;

const DEFAULT_SUBNET = "sn56";
const DEFAULT_TASK_BUDGET_MICRO_USDC = 5_000_000;

// ---------------------------------------------------------------------------
// Canned demo job: a deterministic fine-tune the buyer
// template's 5-minute journey hires this bot for. The "model" learns the fixed
// affine map y = 2x + 1 on a fixed dataset; the deliverable is the model's
// predictions on that dataset. Acceptance is machine-checkable and recomputed by
// the BUYER (see scoreGradientsDemoDeliverable); the worker's self-reported eval
// score is never trusted.
// ---------------------------------------------------------------------------

/** Stable marker on the demo spec's metadata so the default subnet stub recognizes it. */
export const GRADIENTS_DEMO_MARKER = "gradients-sn56-demo-v1";

/** The demo eval floor: predictions must be at least this accurate to be accepted. */
export const GRADIENTS_DEMO_EVAL_FLOOR = 0.8;

/** The demo's fixed inputs. The reference target maps each `x` to `2x + 1`. */
const DEMO_DATASET: readonly number[] = [3, 7, 11, 15, 19];

function demoExpectedOutputs(): number[] {
  return DEMO_DATASET.map((x) => 2 * x + 1);
}

/**
 * The canned Gradients demo job. Deterministic; its specHash is pinned by a test
 * because the buyer journey depends on hash stability.
 */
export const gradientsDemoJobSpec: TaskSpec = {
  version: "1.0.0",
  // TaskType has no fine-tune category; "custom" is the canonical fallback.
  taskType: "custom",
  description:
    "Fine-tune the reference model on the canned SN56 demo dataset and return its " +
    "predictions on the same inputs. The target map is y = 2x + 1. Acceptance is " +
    "deterministic and recomputed by the buyer: prediction accuracy must be >= 0.8; " +
    "the worker's self-reported eval score is not trusted.",
  acceptanceCriteria: [
    {
      id: "ac-eval-floor",
      description:
        "Prediction accuracy on the demo dataset is >= 0.8, recomputed by the buyer from the deliverable.",
      required: true,
    },
  ],
  deliverableFormat: { type: "json" },
  metadata: {
    demo: GRADIENTS_DEMO_MARKER,
    dataset: [...DEMO_DATASET],
    target: "y = 2x + 1",
    evalFloor: GRADIENTS_DEMO_EVAL_FLOOR,
  },
};

/**
 * The reference solution to the demo job: the correct predictions plus a
 * (self-reported, buyer-ignored) eval block, as canonical JSON. Deterministic.
 * Exposed so the demo journey and tests share one source of the expected artifact.
 */
export function solveGradientsDemo(): string {
  const predictions = demoExpectedOutputs();
  return canonicalize({
    checkpoint: "reference-sn56-demo-checkpoint",
    eval: { metric: "accuracy", score: 1 },
    predictions,
  });
}

interface DemoDeliverable {
  predictions: number[];
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
  const predictions = (parsed as { predictions?: unknown }).predictions;
  if (!Array.isArray(predictions) || predictions.some((p) => typeof p !== "number")) {
    return null;
  }
  return { predictions: predictions as number[] };
}

/**
 * The BUYER's independent recompute of the demo eval score in [0, 1]. Reads the
 * substantive output (the predictions) and compares it to the target map the buyer
 * itself defines; it deliberately IGNORES any self-reported `eval.score` in the
 * deliverable, so release can never be worker-controlled. Malformed
 * or unparseable content scores 0 and never throws.
 */
export function scoreGradientsDemoDeliverable(content: string | Buffer): number {
  const parsed = parseDemoDeliverable(content);
  if (parsed === null) {
    return 0;
  }
  const expected = demoExpectedOutputs();
  let matches = 0;
  for (let i = 0; i < expected.length; i++) {
    if (parsed.predictions[i] === expected[i]) {
      matches++;
    }
  }
  return matches / expected.length;
}

// A generic (non-demo) fine-tune produces a placeholder checkpoint+eval so a fresh
// worker returns a well-formed ServiceResult before a real SN56 miner is wired.
function referencePlaceholder(spec: TaskSpec): string {
  return canonicalize({
    checkpoint: "reference-sn56-checkpoint",
    eval: { metric: "accuracy", score: 0 },
    note: "reference stub - replace the callSubnet port with a real SN56 miner call.",
    taskType: spec.taskType,
  });
}

const defaultCallSubnet: SubnetCall = (spec) =>
  Promise.resolve(
    spec.metadata.demo === GRADIENTS_DEMO_MARKER
      ? solveGradientsDemo()
      : referencePlaceholder(spec),
  );

/**
 * Build a Gradients (SN56) {@link ServiceAdapter}. Passes `assertServiceAdapterContract`
 * with the default ports; supply real ports for production use. The USDC->TAO swap,
 * pinning, and execute skeleton come from the shared Bittensor core.
 */
export function createGradientsAdapter(config: GradientsAdapterConfig = {}): ServiceAdapter {
  return createBittensorSubnetAdapter({
    subnet: config.subnet ?? DEFAULT_SUBNET,
    capabilities: config.capabilities ?? [...GRADIENTS_CAPABILITIES],
    taskBudgetMicroUsdc: config.taskBudgetMicroUsdc ?? DEFAULT_TASK_BUDGET_MICRO_USDC,
    swap: config.swap ?? defaultSwap,
    callSubnet: config.callSubnet ?? defaultCallSubnet,
    pin: config.pin ?? defaultPin,
    checkHealth: config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true)),
  });
}
