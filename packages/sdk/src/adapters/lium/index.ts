/**
 * Lium (Bittensor SN51) ServiceAdapter: a SHIPPED, supported adapter following the
 * Gradients pattern. A Worker Bot wraps the Lium GPU-compute subnet behind the
 * `ServiceAdapter` interface: it swaps a per-task USDC budget into TAO internally,
 * rents GPU compute from subnet miners in TAO to run the job, collects the output
 * artifact, and returns a currency-free `ServiceResult`. The Buyer and the escrow
 * contract only ever see USDC; no TAO-typed value crosses this boundary into SDK core
 * (the branded `Tao` type of ../bittensor/index.ts keeps it out at compile time for the
 * Bittensor trio).
 *
 * The swap, GPU-job call, and pinning are injectable ports so the reference runs (and
 * is tested) without a live DEX, subnet, or IPFS node. A production worker supplies
 * real implementations (Jupiter for the swap, the SN51 GPU-rental dendrite,
 * Pinata/Arweave for pinning).
 *
 * RELEASE JUDGMENT IS NOT HERE. This adapter only PRODUCES the deliverable (the job's
 * output artifact). Whether the job completed with a matching artifact is decided by
 * the BUYER's review.ts, which independently recomputes the scripted job's output and
 * compares hashes (see `scoreLiumDemoDeliverable`). The worker never scores-for-release
 * and never releases, and its self-reported `artifactHash` is never trusted
 * (the buyer is the judge).
 *
 * The USDC->TAO port skeleton and the execute shape are shared with the other Bittensor
 * adapters via `../bittensor/index.js`; this module supplies only its subnet identity,
 * capabilities, budget, and demo logic. A GPU-rental call is a paid subnet call, so its
 * port reuses the shared `SubnetCall` shape under the local `RunGpuJob` name.
 */
import { canonicalize, type TaskSpec } from "@escro/shared";

import type { ServiceAdapter } from "../../adapter.js";
import {
  createBittensorSubnetAdapter,
  defaultPin,
  defaultSwap,
  sha256Hex,
  type PinContent,
  type SubnetCall,
  type UsdcToTaoSwap,
} from "../bittensor/index.js";

/** Rent GPU compute for `budget` TAO and run `spec`'s job; resolve with the raw output artifact. */
export type RunGpuJob = SubnetCall;

/** Configuration and injectable ports for {@link createLiumAdapter}. */
export interface LiumAdapterConfig {
  /** Subnet identifier. Defaults to "sn51" (Lium GPU compute); forms the adapter id `bittensor:<subnet>`. */
  subnet?: string;
  /** Advertised capabilities for EscroBots discovery. Defaults to `["gpu-compute"]`. */
  capabilities?: string[];
  /** μUSDC the worker allocates to a single task before converting to TAO (internal budgeting). */
  taskBudgetMicroUsdc?: number;
  /** Swap port. Default: a fixed-rate reference stub. */
  swap?: UsdcToTaoSwap;
  /** GPU-job port. Default: runs the canned demo job; a deterministic placeholder otherwise. */
  runJob?: RunGpuJob;
  /** Pinning port. Default: a deterministic `ipfs://` placeholder URI. */
  pin?: PinContent;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

// Stable id/capabilities. The adapter's own tests pin its runtime output to these
// constants, and the kit's tests cross-check them against `ADAPTER_DESCRIPTORS.lium` in
// create-escro-bot so the registry descriptor and the shipped adapter cannot drift apart.
export const LIUM_ADAPTER_ID = "bittensor:sn51";
export const LIUM_CAPABILITIES = ["gpu-compute"] as const;

const DEFAULT_SUBNET = "sn51";
const DEFAULT_TASK_BUDGET_MICRO_USDC = 20_000_000;

// ---------------------------------------------------------------------------
// Canned demo job: a 5-minute scripted GPU job the buyer
// template's journey hires this bot for. The "GPU job" is a deterministic hash
// chain over a fixed seed, so its output artifact is reproducible: the buyer
// RECOMPUTES it independently (see scoreLiumDemoDeliverable) and releases only when
// the job completed, an artifact is present, and its hash matches. The worker's
// self-reported artifactHash is never trusted.
// ---------------------------------------------------------------------------

/** Stable marker on the demo spec's metadata so the default job stub recognizes it. */
export const LIUM_DEMO_MARKER = "lium-sn51-demo-v1";

/** The demo accept floor: hash-match is exact, so the buyer requires a full match. */
export const LIUM_DEMO_ACCEPT_FLOOR = 1;

const DEMO_SEED = "lium-sn51-demo-seed";
const DEMO_ROUNDS = 1000;

/**
 * The scripted GPU job's deterministic output artifact: a hash chain over the fixed
 * seed. Deterministic and cheap to recompute, so the buyer can verify it independently.
 */
export function computeLiumDemoArtifact(): string {
  let h = DEMO_SEED;
  for (let i = 0; i < DEMO_ROUNDS; i++) {
    h = sha256Hex(h);
  }
  return h;
}

/**
 * The canned Lium demo job. Deterministic; its specHash is pinned by a test because
 * the buyer journey depends on hash stability.
 */
export const liumDemoJobSpec: TaskSpec = {
  version: "1.0.0",
  // TaskType has no GPU-compute category; "custom" is the canonical fallback.
  taskType: "custom",
  description:
    "Run the canned SN51 scripted GPU job (a fixed hash-chain compute over a known " +
    "seed) and return its output artifact. Acceptance is deterministic and recomputed " +
    "by the buyer: the job must complete, an output artifact must be present, and the " +
    "artifact must match the buyer's independent recompute; the worker's self-reported " +
    "artifact hash is not trusted.",
  acceptanceCriteria: [
    {
      id: "ac-completion",
      description: "The scripted job ran to completion (status=completed).",
      required: true,
    },
    {
      id: "ac-artifact-present",
      description: "An output artifact is present in the deliverable.",
      required: true,
    },
    {
      id: "ac-hash-match",
      description:
        "The output artifact matches the buyer's independent recompute of the scripted job.",
      required: true,
    },
  ],
  deliverableFormat: { type: "json" },
  metadata: {
    demo: LIUM_DEMO_MARKER,
    seed: DEMO_SEED,
    rounds: DEMO_ROUNDS,
    acceptFloor: LIUM_DEMO_ACCEPT_FLOOR,
  },
};

/**
 * The reference solution to the demo job: the completed job report carrying the
 * correct output artifact plus a (self-reported, buyer-ignored) artifactHash, as
 * canonical JSON. Deterministic. Exposed so the demo journey and tests share one
 * source of the expected artifact.
 */
export function solveLiumDemo(): string {
  const artifact = computeLiumDemoArtifact();
  return canonicalize({
    job: LIUM_DEMO_MARKER,
    status: "completed",
    rounds: DEMO_ROUNDS,
    artifact,
    // Self-reported and deliberately ignored by the buyer's recompute.
    artifactHash: sha256Hex(artifact),
  });
}

interface DemoDeliverable {
  status: string;
  artifact: string | null;
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
  const obj = parsed as { status?: unknown; artifact?: unknown };
  const status = typeof obj.status === "string" ? obj.status : "";
  const artifact = typeof obj.artifact === "string" ? obj.artifact : null;
  return { status, artifact };
}

/**
 * The BUYER's independent recompute of the demo acceptance predicate, returning 1
 * when the deliverable satisfies all three criteria and 0 otherwise. It checks
 * completion (status), artifact presence, and hash match by RECOMPUTING the scripted
 * job's output and comparing the substantive artifact; it deliberately IGNORES any
 * self-reported `artifactHash`, so release can never be worker-controlled.
 * Malformed or unparseable content scores 0 and never throws.
 */
export function scoreLiumDemoDeliverable(content: string | Buffer): number {
  const parsed = parseDemoDeliverable(content);
  if (parsed === null) {
    return 0;
  }
  if (parsed.status !== "completed") {
    return 0;
  }
  if (parsed.artifact === null) {
    return 0;
  }
  return parsed.artifact === computeLiumDemoArtifact() ? 1 : 0;
}

// A generic (non-demo) GPU job produces a placeholder completion report so a fresh
// worker returns a well-formed ServiceResult before a real SN51 miner is wired.
function referencePlaceholder(spec: TaskSpec): string {
  return canonicalize({
    job: "lium-sn51-generic",
    status: "completed",
    artifact: null,
    note: "reference stub - replace the runJob port with a real SN51 GPU-rental call.",
    taskType: spec.taskType,
  });
}

const defaultRunJob: RunGpuJob = (spec) =>
  Promise.resolve(
    spec.metadata.demo === LIUM_DEMO_MARKER ? solveLiumDemo() : referencePlaceholder(spec),
  );

/**
 * Build a Lium (SN51) {@link ServiceAdapter}. Passes `assertServiceAdapterContract`
 * with the default ports; supply real ports for production use. The USDC->TAO swap,
 * pinning, and execute skeleton come from the shared Bittensor core; the GPU-rental
 * port is wired in as the core's `callSubnet`.
 */
export function createLiumAdapter(config: LiumAdapterConfig = {}): ServiceAdapter {
  return createBittensorSubnetAdapter({
    subnet: config.subnet ?? DEFAULT_SUBNET,
    capabilities: config.capabilities ?? [...LIUM_CAPABILITIES],
    taskBudgetMicroUsdc: config.taskBudgetMicroUsdc ?? DEFAULT_TASK_BUDGET_MICRO_USDC,
    swap: config.swap ?? defaultSwap,
    callSubnet: config.runJob ?? defaultRunJob,
    pin: config.pin ?? defaultPin,
    checkHealth: config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true)),
  });
}
