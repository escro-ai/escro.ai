/**
 * Akash (Cosmos) ServiceAdapter: a SHIPPED, supported reference adapter that extends the
 * ServiceAdapter library beyond Bittensor. A Worker Bot
 * wraps an Akash deployment behind the `ServiceAdapter` interface: it swaps a per-task
 * USDC budget into AKT internally, provisions a deployment/lease on the Akash decentralized
 * cloud (paying providers in AKT), runs the compute job, collects the output artifact, and
 * returns a currency-free `ServiceResult`. The Buyer and the escrow contract only ever see
 * USDC; no AKT-typed value crosses this boundary into SDK core (the branded `Akt` type
 * keeps it out at compile time).
 *
 * Akash is Cosmos-based and billed in its own token (AKT), so -- like the Bittensor trio --
 * it converts USDC internally. But it is NOT a Bittensor subnet (its id is a bare "akash",
 * not `bittensor:<subnet>`), so it does not use the `adapters/bittensor` core: it carries
 * its own branded `Akt` and its own swap port.
 *
 * The swap, deployment call, and pinning are injectable ports so the reference runs (and is
 * tested) without a live DEX, Akash provider, or IPFS node. A production worker supplies
 * real implementations (a DEX/CEX route for the USDC->AKT swap, the Akash SDL/lease flow for
 * the deployment, Pinata/Arweave for pinning). The swap default is a fixed reference rate,
 * not a live price feed -- no price-feed dependency is introduced anywhere in SDK core
 * (the escrow contract takes no price feed; the reference rate here is a nominal constant a
 * real worker replaces with its own routing).
 *
 * RELEASE JUDGMENT IS NOT HERE. This adapter only PRODUCES the deliverable (the job's output
 * artifact). Whether the job completed with a matching artifact is decided by the BUYER's
 * review.ts, which independently recomputes the scripted job's output and compares hashes
 * (see `scoreAkashDemoDeliverable`). The worker never scores-for-release and never releases,
 * and its self-reported `artifactHash` is never trusted: the buyer is the judge.
 */
import { createHash } from "crypto";

import { canonicalize, type TaskSpec } from "@escro/shared";

import type { ServiceAdapter, ServiceResult } from "../../adapter.js";

/**
 * Amount denominated in AKT (Akash's token). Branded so it cannot be assigned to or from a
 * plain `number` by accident and (the point of the brand) so it can never appear in a
 * `ServiceResult` or the escrow submit path: those types have no field of this type. AKT
 * exists ONLY inside the Akash adapter layer.
 */
export type Akt = number & { readonly __brand: "AKT" };

/** Construct an {@link Akt} amount from a plain number. Adapter-internal use only. */
export function akt(amount: number): Akt {
  return amount as Akt;
}

/** Swap a microUSDC budget into AKT. Real workers route this through a DEX/CEX. */
export type UsdcToAktSwap = (microUsdc: number) => Promise<Akt>;

/**
 * Provision an Akash deployment/lease funded with `budget` AKT to run `spec`; resolve with
 * the raw deliverable (the job's output artifact).
 */
export type RunAkashDeployment = (spec: TaskSpec, budget: Akt) => Promise<string | Buffer>;

/** Pin `content` and resolve with a content-addressed proof URI (ipfs://, ar://). */
export type PinContent = (content: string | Buffer) => Promise<string>;

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Stable id/capabilities. The adapter's own tests pin its runtime output to these
 * constants; the EscroBots registry descriptor for `akash` is registered separately (the
 * capability taxonomy).
 */
export const AKASH_ADAPTER_ID = "akash";
export const AKASH_CAPABILITIES = ["cloud-compute"] as const;

const DEFAULT_TASK_BUDGET_MICRO_USDC = 10_000_000;

// Nominal reference rate: microUSDC -> AKT. Only the stub swap cares about the exact value;
// it is a fixed constant, never a live price feed (a real worker replaces the swap port).
export const REFERENCE_MICRO_USDC_PER_AKT = 3_000_000;

/** Default fixed-rate reference swap. */
const defaultSwap: UsdcToAktSwap = (microUsdc) =>
  Promise.resolve(akt(microUsdc / REFERENCE_MICRO_USDC_PER_AKT));

/** Default deterministic `ipfs://` placeholder pin. */
const defaultPin: PinContent = (content) =>
  Promise.resolve(`ipfs://placeholder-${sha256Hex(content).slice(0, 16)}`);

/** Configuration and injectable ports for {@link createAkashAdapter}. */
export interface AkashAdapterConfig {
  /** Advertised capabilities for EscroBots discovery. Defaults to `["cloud-compute"]`. */
  capabilities?: string[];
  /** μUSDC the worker allocates to a single task before converting to AKT (internal budgeting). */
  taskBudgetMicroUsdc?: number;
  /** Swap port. Default: a fixed-rate reference stub. */
  swap?: UsdcToAktSwap;
  /** Deployment port. Default: runs the canned demo job; a deterministic placeholder otherwise. */
  runDeployment?: RunAkashDeployment;
  /** Pinning port. Default: a deterministic `ipfs://` placeholder URI. */
  pin?: PinContent;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Canned demo job: a deterministic batch compute job the buyer template's journey
// hires this bot for. The "compute job" is a deterministic hash chain over a fixed
// seed, so its output artifact is reproducible: the buyer RECOMPUTES it independently
// (see scoreAkashDemoDeliverable) and releases only when the job completed, an artifact
// is present, and its hash matches. The worker's self-reported artifactHash is never
// trusted.
// ---------------------------------------------------------------------------

/** Stable marker on the demo spec's metadata so the default deployment stub recognizes it. */
export const AKASH_DEMO_MARKER = "akash-demo-v1";

/** The demo accept floor: hash-match is exact, so the buyer requires a full match. */
export const AKASH_DEMO_ACCEPT_FLOOR = 1;

const DEMO_SEED = "akash-demo-seed";
const DEMO_ROUNDS = 1000;

/**
 * The scripted batch job's deterministic output artifact: a hash chain over the fixed
 * seed. Deterministic and cheap to recompute, so the buyer can verify it independently.
 */
export function computeAkashDemoArtifact(): string {
  let h = DEMO_SEED;
  for (let i = 0; i < DEMO_ROUNDS; i++) {
    h = sha256Hex(h);
  }
  return h;
}

/**
 * The canned Akash demo job. Deterministic; its specHash is pinned by a test because the
 * buyer journey depends on hash stability.
 */
export const akashDemoJobSpec: TaskSpec = {
  version: "1.0.0",
  // TaskType has no cloud-compute category; "custom" is the canonical fallback.
  taskType: "custom",
  description:
    "Run the canned Akash scripted batch job (a fixed hash-chain compute over a known " +
    "seed) on a deployment and return its output artifact. Acceptance is deterministic and " +
    "recomputed by the buyer: the job must complete, an output artifact must be present, and " +
    "the artifact must match the buyer's independent recompute; the worker's self-reported " +
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
    demo: AKASH_DEMO_MARKER,
    seed: DEMO_SEED,
    rounds: DEMO_ROUNDS,
    acceptFloor: AKASH_DEMO_ACCEPT_FLOOR,
  },
};

/**
 * The reference solution to the demo job: the completed job report carrying the correct
 * output artifact plus a (self-reported, buyer-ignored) artifactHash, as canonical JSON.
 * Deterministic. Exposed so the demo journey and tests share one source of the expected
 * artifact.
 */
export function solveAkashDemo(): string {
  const artifact = computeAkashDemoArtifact();
  return canonicalize({
    job: AKASH_DEMO_MARKER,
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as { status?: unknown; artifact?: unknown };
  const status = typeof obj.status === "string" ? obj.status : "";
  const artifact = typeof obj.artifact === "string" ? obj.artifact : null;
  return { status, artifact };
}

/**
 * The BUYER's independent recompute of the demo acceptance predicate, returning 1 when the
 * deliverable satisfies all three criteria and 0 otherwise. It checks completion (status),
 * artifact presence, and hash match by RECOMPUTING the scripted job's output and comparing
 * the substantive artifact; it deliberately IGNORES any self-reported `artifactHash`, so
 * release can never be worker-controlled. Malformed or unparseable content scores 0 and
 * never throws.
 */
export function scoreAkashDemoDeliverable(content: string | Buffer): number {
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
  return parsed.artifact === computeAkashDemoArtifact() ? 1 : 0;
}

// A generic (non-demo) job produces a placeholder completion report so a fresh worker
// returns a well-formed ServiceResult before a real Akash deployment is wired.
function referencePlaceholder(spec: TaskSpec): string {
  return canonicalize({
    job: "akash-generic",
    status: "completed",
    artifact: null,
    note: "reference stub - replace the runDeployment port with a real Akash deployment call.",
    taskType: spec.taskType,
  });
}

const defaultRunDeployment: RunAkashDeployment = (spec) =>
  Promise.resolve(
    spec.metadata.demo === AKASH_DEMO_MARKER ? solveAkashDemo() : referencePlaceholder(spec),
  );

/**
 * Build an Akash {@link ServiceAdapter}. Passes `assertServiceAdapterContract` with the
 * default ports; supply real ports for production use. The execute skeleton: swap the USDC
 * budget into AKT (internal, never surfaced), provision the deployment and collect the
 * output, then hash and pin. The recorded `ServiceResult` is currency-free (no AKT field).
 */
export function createAkashAdapter(config: AkashAdapterConfig = {}): ServiceAdapter {
  const capabilities = config.capabilities ?? [...AKASH_CAPABILITIES];
  const taskBudgetMicroUsdc = config.taskBudgetMicroUsdc ?? DEFAULT_TASK_BUDGET_MICRO_USDC;
  const swap = config.swap ?? defaultSwap;
  const runDeployment = config.runDeployment ?? defaultRunDeployment;
  const pin = config.pin ?? defaultPin;
  const checkHealth = config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true));

  return {
    id: AKASH_ADAPTER_ID,
    capabilities,
    healthCheck: checkHealth,
    async execute(spec: TaskSpec): Promise<ServiceResult> {
      // 1. Swap the USDC budget into AKT (internal, never surfaced).
      const budgetAkt = await swap(taskBudgetMicroUsdc);
      // 2. Provision the Akash deployment (paid in AKT) and collect the deliverable.
      const content = await runDeployment(spec, budgetAkt);
      // 3. Hash and pin. The result the escrow records is currency-free.
      const contentHash = sha256Hex(content);
      const proofUri = await pin(content);
      return {
        content,
        contentHash,
        proofUri,
        metadata: { adapter: AKASH_ADAPTER_ID },
      };
    },
  };
}
