/**
 * Gensyn ServiceAdapter + REE-proof acceptance. Gensyn is a
 * network for VERIFIABLE compute: a worker runs a job in a Reproducible Execution
 * Environment (REE) and returns a proof that binds the task, the delivered output,
 * and a reproducible execution transcript. Acceptance is buyer-side and by proof:
 * the Buyer auto-releases iff the REE proof verifies.
 *
 * The judgment is entirely BUYER-LAYER (this module, called by the buyer's bot),
 * exactly like `scoreGradientsDemoDeliverable` in the Gradients adapter. The
 * protocol still judges nothing: verification never enters the program or the
 * oracle, and this module imports no on-chain or oracle code.
 *
 * `verifyReeProof` is deliberately a BUYER recompute, mirroring the Gradients
 * pattern where the buyer re-derives the eval score rather than trusting the
 * worker's self-report: it re-runs the reproducible execution and checks the
 * worker's transcript hash against its own. A production Gensyn verifier would
 * replace the full recompute with Gensyn's interactive verification game over the
 * same `transcriptHash`; the acceptance contract (a proof binding spec, content,
 * and reproducible transcript) is unchanged.
 */
import { createHash } from "crypto";

import {
  canonicalize,
  type ReviewDeliverable,
  type ReviewPolicy,
  type ReviewResult,
  type TaskSpec,
} from "@escro/shared";

import type { ResolveProofUri, ServiceAdapter, ServiceResult } from "../../adapter.js";
import { EscroError } from "../../errors.js";

/** Stable adapter identity + EscroBots capability (pinned by a test). */
export const GENSYN_ADAPTER_ID = "gensyn";
export const GENSYN_CAPABILITIES = ["verifiable-compute"] as const;

/** REE proof scheme tag. A verifier accepts only proofs carrying this exact scheme. */
export const GENSYN_REE_SCHEME = "gensyn-ree-v1";

/** Marker on the demo spec's metadata so the default reproducible compute recognizes it. */
export const GENSYN_DEMO_MARKER = "gensyn-ree-demo-v1";

/** The demo's fixed reproducible-execution parameters (a deterministic LCG walk). */
export const GENSYN_DEMO_SEED = 12345;
export const GENSYN_DEMO_STEPS = 16;

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Reproducible execution: the deterministic computation the REE proof attests to.
// A fixed linear congruential generator walked `steps` times from `seed`; the
// ordered states are the transcript, the final state is the result. Deterministic
// from the spec alone, so the buyer can reproduce it and confirm the worker's
// transcript hash (the essence of a Reproducible Execution Environment).
// ---------------------------------------------------------------------------

const LCG_MULT = 1103515245n;
const LCG_INC = 12345n;
const LCG_MOD = 1n << 31n;

/** The result of one reproducible execution: its transcript and final output. */
export interface ReeExecution {
  /** Seed the walk started from. */
  seed: number;
  /** Number of steps walked. */
  steps: number;
  /** Ordered per-step states (the execution transcript). */
  states: number[];
  /** Final state (the deliverable's numeric result). */
  result: number;
}

/** Run the reproducible compute for `spec`, deriving the transcript and result. */
export type ReproduceCompute = (spec: TaskSpec) => ReeExecution;

function readComputeParams(spec: TaskSpec): { seed: number; steps: number } {
  const rawSeed = spec.metadata.seed;
  const rawSteps = spec.metadata.steps;
  const seed =
    typeof rawSeed === "number" && Number.isInteger(rawSeed) ? rawSeed : GENSYN_DEMO_SEED;
  const steps =
    typeof rawSteps === "number" && Number.isInteger(rawSteps) && rawSteps > 0
      ? rawSteps
      : GENSYN_DEMO_STEPS;
  return { seed, steps };
}

/**
 * The reference reproducible execution. Deterministic from `spec` (its seed/steps
 * come from `spec.metadata`, defaulting to the demo parameters), so both worker and
 * buyer derive the same transcript.
 */
export const reproduceGensynCompute: ReproduceCompute = (spec) => {
  const { seed, steps } = readComputeParams(spec);
  const states: number[] = [];
  let x = BigInt(seed) % LCG_MOD;
  if (x < 0n) {
    x += LCG_MOD;
  }
  for (let i = 0; i < steps; i++) {
    x = (LCG_MULT * x + LCG_INC) % LCG_MOD;
    states.push(Number(x));
  }
  return { seed, steps, states, result: states[states.length - 1] ?? seed };
};

/** Serialize a reproducible execution's output into the deliverable content. */
export function gensynDeliverable(exec: ReeExecution): string {
  return canonicalize({ result: exec.result, steps: exec.steps });
}

// ---------------------------------------------------------------------------
// REE proof
// ---------------------------------------------------------------------------

/**
 * A Gensyn REE proof. Every field is a commitment the buyer re-derives:
 * `commitment` binds the whole tuple, `outputHash` binds the delivered content,
 * `specHash` binds the task asked, `transcriptHash` binds the reproducible run.
 */
export interface ReeProof {
  scheme: typeof GENSYN_REE_SCHEME;
  /** SHA-256 hex of the canonical task spec. */
  specHash: string;
  /** SHA-256 hex of the delivered content. */
  outputHash: string;
  /** Number of reproducible execution steps (positive integer). */
  steps: number;
  /** SHA-256 hex of the canonical execution transcript. */
  transcriptHash: string;
  /** SHA-256 hex binding scheme, specHash, outputHash, steps, and transcriptHash. */
  commitment: string;
}

type ReeProofBase = Omit<ReeProof, "commitment">;

/** The single canonical binding the commitment (and its verification) is computed over. */
function commitmentOf(base: ReeProofBase): string {
  return sha256Hex(
    [base.scheme, base.specHash, base.outputHash, String(base.steps), base.transcriptHash].join(
      "\n",
    ),
  );
}

/**
 * Build the REE proof a worker attaches to its deliverable. Not a trust anchor on
 * its own: `verifyReeProof` re-derives every field, so a proof only accepts when it
 * genuinely binds the content, spec, and a reproducible transcript.
 */
export function buildReeProof(
  spec: TaskSpec,
  exec: ReeExecution,
  content: string | Buffer,
): ReeProof {
  const base: ReeProofBase = {
    scheme: GENSYN_REE_SCHEME,
    specHash: sha256Hex(canonicalize(spec)),
    outputHash: sha256Hex(content),
    steps: exec.steps,
    transcriptHash: sha256Hex(canonicalize(exec.states)),
  };
  return { ...base, commitment: commitmentOf(base) };
}

/** The verifier's verdict: a proof is either valid, or invalid/malformed with a reason. */
export interface ReeVerification {
  valid: boolean;
  /** Prefixed `malformed` (shape/structure) or `invalid` (a binding failed), or a pass note. */
  reason: string;
}

/** Inputs the buyer verifies a proof against: the task asked and the content received. */
export interface ReeVerifyContext {
  /** The task spec the buyer commissioned. */
  spec: TaskSpec;
  /** The deliverable content the buyer received (fetched from proofUri in production). */
  content: string | Buffer;
  /** The reproducible compute; defaults to the reference {@link reproduceGensynCompute}. */
  reproduce?: ReproduceCompute;
}

const HEX_64 = /^[0-9a-f]{64}$/;

function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX_64.test(v);
}

function malformed(reason: string): ReeVerification {
  return { valid: false, reason: `malformed: ${reason}` };
}

function invalid(reason: string): ReeVerification {
  return { valid: false, reason: `invalid: ${reason}` };
}

/**
 * The BUYER's verification of an REE proof (untrusted input from the worker). Returns
 * `valid: true` only when the proof is well-formed AND every binding holds: the
 * commitment is self-consistent, the committed output hash equals the delivered
 * content, the spec hash equals the commissioned task, and the transcript hash
 * matches the buyer's own reproduction of the execution. Never throws.
 */
export function verifyReeProof(proof: unknown, ctx: ReeVerifyContext): ReeVerification {
  if (typeof proof !== "object" || proof === null) {
    return malformed("proof is not an object");
  }
  const p = proof as Record<string, unknown>;

  if (p.scheme !== GENSYN_REE_SCHEME) {
    return malformed(`scheme must be "${GENSYN_REE_SCHEME}"`);
  }
  if (!isHex64(p.specHash)) {
    return malformed("specHash must be a 64-char lowercase hex string");
  }
  if (!isHex64(p.outputHash)) {
    return malformed("outputHash must be a 64-char lowercase hex string");
  }
  if (!isHex64(p.transcriptHash)) {
    return malformed("transcriptHash must be a 64-char lowercase hex string");
  }
  if (!isHex64(p.commitment)) {
    return malformed("commitment must be a 64-char lowercase hex string");
  }
  if (typeof p.steps !== "number" || !Number.isInteger(p.steps) || p.steps <= 0) {
    return malformed("steps must be a positive integer");
  }

  const base: ReeProofBase = {
    scheme: GENSYN_REE_SCHEME,
    specHash: p.specHash,
    outputHash: p.outputHash,
    steps: p.steps,
    transcriptHash: p.transcriptHash,
  };

  if (commitmentOf(base) !== p.commitment) {
    return invalid("commitment does not bind the proof fields (tampered)");
  }
  if (sha256Hex(ctx.content) !== p.outputHash) {
    return invalid("outputHash does not match the delivered content");
  }
  if (sha256Hex(canonicalize(ctx.spec)) !== p.specHash) {
    return invalid("specHash does not match the commissioned task spec");
  }
  const exec = (ctx.reproduce ?? reproduceGensynCompute)(ctx.spec);
  if (p.steps !== exec.steps) {
    return invalid("steps does not match the reproduced execution");
  }
  if (sha256Hex(canonicalize(exec.states)) !== p.transcriptHash) {
    return invalid("transcriptHash is not reproducible from the task spec");
  }
  // The load-bearing acceptance check: the delivered content must be the ACTUAL output
  // of the reproduced execution, not merely something the worker hashed into a
  // self-consistent proof. Without this, a worker could attach a valid proof to
  // arbitrary content (its outputHash would still equal the delivered garbage) and
  // trigger auto-release. Binding outputHash to the buyer's own reproduced deliverable
  // (and, via the check above, to the delivered content) closes that forgery.
  if (sha256Hex(gensynDeliverable(exec)) !== p.outputHash) {
    return invalid("outputHash does not match the reproduced deliverable");
  }

  return {
    valid: true,
    reason:
      "REE proof verified: commitment, spec, transcript, and the reproduced deliverable all bind to the delivered content.",
  };
}

// ---------------------------------------------------------------------------
// Buyer-layer auto-release
// ---------------------------------------------------------------------------

/** What the buyer assembles to decide acceptance: the received content and the worker's proof. */
export interface GensynDeliverableBundle {
  /** The deliverable content the buyer received. */
  content: string | Buffer;
  /** The REE proof the worker attached (untrusted; verified before any release). */
  proof: unknown;
}

/** A buyer auto-release decision. `release: true` means "call release_payment()". */
export interface AutoReleaseDecision {
  release: boolean;
  reason: string;
}

/**
 * The buyer bot's auto-release decision for a Gensyn deliverable. Releases ONLY when
 * the REE proof verifies against the delivered content and the commissioned spec;
 * an invalid or malformed proof never releases. This is the whole acceptance
 * mechanism, and it lives entirely at the buyer layer.
 */
export function gensynAutoRelease(
  bundle: GensynDeliverableBundle,
  ctx: { spec: TaskSpec; reproduce?: ReproduceCompute },
): AutoReleaseDecision {
  const verdict = verifyReeProof(bundle.proof, {
    spec: ctx.spec,
    content: bundle.content,
    ...(ctx.reproduce !== undefined && { reproduce: ctx.reproduce }),
  });
  return { release: verdict.valid, reason: verdict.reason };
}

/** Encode the document a Gensyn worker pins: the deliverable content and its REE proof. */
export function encodeGensynBundle(bundle: { content: string; proof: ReeProof }): string {
  return canonicalize(bundle);
}

/**
 * Decode the document a `proofUri` resolves to. Returns null unless it parses to an object
 * with a string `content` and an object `proof` (the proof itself is verified later).
 */
export function decodeGensynBundle(document: string | Buffer): GensynDeliverableBundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof document === "string" ? document : document.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const { content, proof } = parsed as Record<string, unknown>;
  if (typeof content !== "string" || typeof proof !== "object" || proof === null) {
    return null;
  }
  return { content, proof };
}

/** Options for {@link gensynProofAutoRelease}. */
export interface GensynProofAutoReleaseOptions {
  /**
   * Fetch the bundle document the submitted `proofUri` names. A throw or rejection
   * propagates (retried), never a verdict.
   */
  resolveProofUri: ResolveProofUri;
  /** The task spec the buyer commissioned; the proof must bind it. */
  spec: TaskSpec;
  /** The reproducible compute; defaults to the reference {@link reproduceGensynCompute}. */
  reproduce?: ReproduceCompute;
}

function gensynDispute(reason: string): ReviewResult {
  return { accept: false, dispute: true, reason };
}

/**
 * Buyer-layer auto-release over the pinned Gensyn bundle. It resolves `proofUri` through
 * `resolveProofUri`, requires the bundle's content to re-hash to the worker-submitted
 * `contentHash`, then releases only when {@link gensynAutoRelease} does; anything else
 * DISPUTES. A resolver that throws propagates: an infrastructure failure is not a verdict.
 * Construction throws `ADAPTER_CONFIG_ERROR` when `resolveProofUri` or `spec` is missing.
 */
export function gensynProofAutoRelease(opts: GensynProofAutoReleaseOptions): ReviewPolicy {
  // A JavaScript caller can pass no options at all; that is a config error, not a TypeError.
  const raw: unknown = opts;
  const given = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof GensynProofAutoReleaseOptions, unknown>
  >;
  if (typeof given.resolveProofUri !== "function") {
    throw new EscroError(
      "gensynProofAutoRelease: `resolveProofUri` must be a function",
      "ADAPTER_CONFIG_ERROR",
    );
  }
  if (typeof given.spec !== "object" || given.spec === null) {
    throw new EscroError("gensynProofAutoRelease: `spec` is required", "ADAPTER_CONFIG_ERROR");
  }
  const { resolveProofUri, spec, reproduce } = opts;
  return {
    name: "gensyn-proof-auto-release",
    async evaluate(d: ReviewDeliverable): Promise<ReviewResult> {
      if (d.proofUri === null || d.proofUri === "") {
        return gensynDispute("no proofUri attached");
      }
      const bundle = decodeGensynBundle(await resolveProofUri(d.proofUri));
      if (bundle === null) {
        return gensynDispute("proofUri does not resolve to a decodable gensyn bundle");
      }
      if (sha256Hex(bundle.content) !== d.contentHash) {
        return gensynDispute(
          "bundle content does not hash to the submitted contentHash (tampered or wrong)",
        );
      }
      const decision = gensynAutoRelease(bundle, {
        spec,
        ...(reproduce !== undefined && { reproduce }),
      });
      return decision.release
        ? { accept: true, dispute: false, reason: decision.reason }
        : gensynDispute(decision.reason);
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter (worker side)
// ---------------------------------------------------------------------------

/** Configuration and injectable ports for {@link createGensynAdapter}. */
export interface GensynAdapterConfig {
  /** Advertised capabilities for EscroBots discovery. Defaults to `["verifiable-compute"]`. */
  capabilities?: string[];
  /** The reproducible compute the worker runs. Default: the reference LCG walk. */
  runCompute?: ReproduceCompute;
  /**
   * Pinning port: receives the bundle document ({@link encodeGensynBundle}) and returns its
   * reference. Default: a deterministic `ipfs://` placeholder URI over those bytes.
   */
  pin?: (content: string | Buffer) => Promise<string>;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

/** The canned demo job the buyer template's journey hires a Gensyn worker for. */
export const gensynDemoJobSpec: TaskSpec = {
  version: "1.0.0",
  taskType: "custom",
  description:
    "Run the reference reproducible compute (a fixed LCG walk from the seed in " +
    "metadata) and return its final result. Acceptance is a valid gensyn-ree-v1 REE " +
    "proof: the buyer recomputes the transcript and confirms the proof binds the " +
    "delivered content, this spec, and the reproducible execution. The worker's " +
    "self-reported result is never trusted on its own.",
  acceptanceCriteria: [
    {
      id: "ac-ree-proof",
      description:
        "A valid gensyn-ree-v1 proof binding the delivered content, this spec, and a reproducible transcript.",
      required: true,
    },
  ],
  deliverableFormat: { type: "json" },
  metadata: {
    demo: GENSYN_DEMO_MARKER,
    seed: GENSYN_DEMO_SEED,
    steps: GENSYN_DEMO_STEPS,
  },
};

const defaultPin = (content: string | Buffer): Promise<string> =>
  Promise.resolve(`ipfs://gensyn-${sha256Hex(content).slice(0, 16)}`);

/**
 * Build a Gensyn {@link ServiceAdapter}. `execute` runs the reproducible compute,
 * serializes the deliverable, builds its REE proof and pins the bundle of both; `proofUri`
 * names that bundle, which the buyer verifies with {@link gensynProofAutoRelease}. Passes
 * `assertServiceAdapterContract` with the default ports; supply real ports (a real
 * Gensyn job runner, a real pinner) for production.
 */
export function createGensynAdapter(config: GensynAdapterConfig = {}): ServiceAdapter {
  const runCompute = config.runCompute ?? reproduceGensynCompute;
  const pin = config.pin ?? defaultPin;
  const checkHealth = config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true));
  const capabilities = config.capabilities ?? [...GENSYN_CAPABILITIES];

  return {
    id: GENSYN_ADAPTER_ID,
    capabilities,
    healthCheck: checkHealth,
    async execute(spec: TaskSpec): Promise<ServiceResult> {
      const exec = runCompute(spec);
      const content = gensynDeliverable(exec);
      const contentHash = sha256Hex(content);
      const proof = buildReeProof(spec, exec, content);
      const proofUri = await pin(encodeGensynBundle({ content, proof }));
      return {
        content,
        contentHash,
        proofUri,
        metadata: { adapter: GENSYN_ADAPTER_ID },
      };
    },
  };
}
