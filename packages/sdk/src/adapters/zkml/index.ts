/**
 * ZKML proof-verifier ServiceAdapter. A Worker Bot wraps a zk-verified
 * inference service: it runs the model, then attaches a proof that the delivered
 * output is the correct result of running a committed model on a committed input.
 * The worker pins one bundle document holding the deliverable and its proof, and
 * `ServiceResult.proofUri` is that document's content-addressed reference; the Buyer
 * resolves it through its own `resolveProofUri` port and configures auto-release on
 * proof validation. Same buyer-layer-only shape as every adapter -- the escrow
 * program and the oracle judge nothing: verification is pure TypeScript that runs
 * in the Buyer's bot, never on-chain and never in the oracle (this module imports
 * no on-chain or oracle code).
 *
 * WHAT THE SHIPPED VERIFIER IS -- AND IS NOT. The default scheme (`escro-zkml-ref-v1`)
 * is a REFERENCE verifier with NO cryptographic soundness. Its tag is a plain keyless
 * hash of the public inputs (see `computeZkmlVerificationTag`) and `buildZkmlProof` is
 * exported, so ANY party can mint a proof that `verifyZkmlProof` accepts, over whatever
 * output it chooses and any model commitment. It exists to demonstrate the lifecycle
 * (proof shape, the pinned bundle behind `proofUri`, decode, and the buyer-side
 * auto-release seam) deterministically and with no external prover. It must NEVER be the sole gate on a
 * production release. A production ZKML buyer passes a REAL SNARK/STARK verifier to
 * `zkmlProofAutoRelease` (the `verify` option): a verifying key over the same public
 * inputs, which is where soundness actually lives.
 *
 * TWO DISCIPLINES THAT DO CARRY TO PRODUCTION. (1) The buyer RE-HASHES the content of
 * the bundle it resolved and requires `sha256(content)` equals the worker-submitted
 * `contentHash` before trusting anything (`zkmlProofAutoRelease`). The submitted
 * hash is the worker's claim, never trusted on its own -- the same discipline as the
 * buyer template's `evalThresholdReview`. (2) Verification is
 * buyer-layer only: it runs in the Buyer's bot, never on-chain and never in the oracle.
 * RELEASE JUDGMENT IS THE BUYER'S: the adapter only
 * PRODUCES the deliverable and its proof; whether to release is `zkmlProofAutoRelease`
 * in the Buyer's review, never the worker and never the protocol.
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

/** Stable id/capabilities; locked against the EscroBots registry descriptor by a kit test at merge. */
export const ZKML_ADAPTER_ID = "zkml";
export const ZKML_CAPABILITIES = ["zk-verified-inference"] as const;

/** Marker on the demo spec's metadata so the default inference port recognizes it. */
export const ZKML_DEMO_MARKER = "zkml-demo-v1";

/** The reference proving scheme this verifier understands. Unknown schemes are malformed to it. */
export const ZKML_PROOF_SCHEME = "escro-zkml-ref-v1";

/** Prefix marking a ZKML bundle document, the bytes a worker pins: `zkml-proof:<base64url(json)>`. */
export const ZKML_PROOF_URI_PREFIX = "zkml-proof:";

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Proof shape ──────────────────────────────────────────────────────────────────

/**
 * A ZKML proof: its public inputs plus a `verificationTag` binding them. In the
 * reference scheme the tag is recomputable (see {@link computeZkmlVerificationTag});
 * in a production scheme it is a SNARK/STARK checked against a verifying key over the
 * same public inputs.
 */
export interface ZkmlProof {
  /** Proving scheme identifier; the verifier only understands {@link ZKML_PROOF_SCHEME}. */
  scheme: string;
  /** Commitment to the model that produced the output (e.g. a weights hash). */
  modelCommitment: string;
  /** Commitment to the input the model was run on. */
  inputCommitment: string;
  /** SHA-256 hex of the delivered output; binds the proof to a specific deliverable. */
  outputHash: string;
  /** Binding tag over the public inputs (reference: recomputable; production: a SNARK). */
  verificationTag: string;
}

/** The public inputs a proof commits to (everything except the tag itself). */
type ZkmlPublicInputs = Omit<ZkmlProof, "verificationTag">;

/** Recompute the reference binding tag over a proof's public inputs. Deterministic. */
export function computeZkmlVerificationTag(publicInputs: ZkmlPublicInputs): string {
  return sha256Hex(
    canonicalize({
      scheme: publicInputs.scheme,
      modelCommitment: publicInputs.modelCommitment,
      inputCommitment: publicInputs.inputCommitment,
      outputHash: publicInputs.outputHash,
    }),
  );
}

/** Build a well-formed reference proof binding the given public inputs. */
export function buildZkmlProof(args: {
  scheme?: string;
  modelCommitment: string;
  inputCommitment: string;
  outputHash: string;
}): ZkmlProof {
  const publicInputs: ZkmlPublicInputs = {
    scheme: args.scheme ?? ZKML_PROOF_SCHEME,
    modelCommitment: args.modelCommitment,
    inputCommitment: args.inputCommitment,
    outputHash: args.outputHash,
  };
  return { ...publicInputs, verificationTag: computeZkmlVerificationTag(publicInputs) };
}

/** The document a ZKML worker pins: the deliverable content and the proof over it. */
export interface ZkmlProofBundle {
  /** The deliverable content; its SHA-256 is the escrow's on-chain `contentHash`. */
  content: string;
  /** The proof binding `content` to the committed model and input. */
  proof: ZkmlProof;
}

/** Encode a bundle as the document a worker pins; `proofUri` is that document's reference. */
export function encodeZkmlProofUri(bundle: ZkmlProofBundle): string {
  return ZKML_PROOF_URI_PREFIX + Buffer.from(canonicalize(bundle), "utf8").toString("base64url");
}

function isProofShaped(value: unknown): value is ZkmlProof {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.scheme === "string" &&
    typeof p.modelCommitment === "string" &&
    typeof p.inputCommitment === "string" &&
    typeof p.outputHash === "string" &&
    typeof p.verificationTag === "string"
  );
}

/**
 * Decode the document a `proofUri` resolves to back to a {@link ZkmlProofBundle}. Returns
 * null for a document without the prefix, an undecodable payload, a `content` that is not
 * a string or a `proof` that is not proof-shaped.
 */
export function decodeZkmlProofUri(document: string | Buffer): ZkmlProofBundle | null {
  const text = typeof document === "string" ? document : document.toString("utf8");
  if (!text.startsWith(ZKML_PROOF_URI_PREFIX)) {
    return null;
  }
  const encoded = text.slice(ZKML_PROOF_URI_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { content, proof } = parsed as Record<string, unknown>;
  return typeof content === "string" && isProofShaped(proof) ? { content, proof } : null;
}

// ── Verification ─────────────────────────────────────────────────────────────────

/**
 * The outcome of verifying a proof. `malformed` = the verifier cannot understand the
 * proof (missing/wrong-typed fields, unsupported scheme, undecodable URI); `invalid`
 * = a well-formed proof that fails verification (tag does not recompute, or attests a
 * different output/model than expected).
 */
export type ZkmlVerification =
  | { valid: true }
  | { valid: false; category: "invalid" | "malformed"; reason: string };

/** What the Buyer expects the proof to attest to: values the Buyer computes itself. */
export interface ZkmlExpectation {
  /** The submitted deliverable's contentHash; the proof's outputHash must equal it. */
  contentHash: string;
  /** The model the Buyer hired; the proof's modelCommitment must equal it. */
  modelCommitment: string;
  /** The Buyer's commitment over its own input; the proof's inputCommitment must equal it. */
  inputCommitment: string;
}

/**
 * Verify a decoded proof against the Buyer's expectation. NOTE: this is the REFERENCE
 * verifier and is NOT cryptographically sound -- the tag is a keyless hash, so a `valid`
 * result means only that the proof is internally consistent and bound to the expected
 * output, model and input, not that a trustworthy party produced it. Pass a real verifier
 * to {@link zkmlProofAutoRelease} for production. `malformed` = an unusable proof;
 * `invalid` = a usable proof that fails the checks.
 */
export function verifyZkmlProof(proof: unknown, expected: ZkmlExpectation): ZkmlVerification {
  if (!isProofShaped(proof)) {
    return { valid: false, category: "malformed", reason: "proof is missing required fields" };
  }
  if (proof.scheme !== ZKML_PROOF_SCHEME) {
    return {
      valid: false,
      category: "malformed",
      reason: `unsupported proof scheme "${proof.scheme}"`,
    };
  }
  if (proof.verificationTag !== computeZkmlVerificationTag(proof)) {
    return {
      valid: false,
      category: "invalid",
      reason:
        "verification tag does not recompute (public inputs altered after the tag was computed)",
    };
  }
  if (proof.outputHash !== expected.contentHash) {
    return {
      valid: false,
      category: "invalid",
      reason: "proof attests a different output than the submitted deliverable",
    };
  }
  if (proof.modelCommitment !== expected.modelCommitment) {
    return { valid: false, category: "invalid", reason: "proof attests a different model" };
  }
  if (proof.inputCommitment !== expected.inputCommitment) {
    return { valid: false, category: "invalid", reason: "proof attests a different input" };
  }
  return { valid: true };
}

/**
 * Decode the document a `proofUri` resolved to (or reject an absent or foreign one),
 * require its content to hash to `expected.contentHash`, then verify its proof.
 */
export function verifyZkmlProofUri(
  document: string | Buffer | null | undefined,
  expected: ZkmlExpectation,
): ZkmlVerification {
  if (document === null || document === undefined) {
    return { valid: false, category: "malformed", reason: "no bundle document resolved" };
  }
  const bundle = decodeZkmlProofUri(document);
  if (bundle === null) {
    return {
      valid: false,
      category: "malformed",
      reason: "document is not a decodable zkml bundle",
    };
  }
  if (sha256Hex(bundle.content) !== expected.contentHash) {
    return {
      valid: false,
      category: "invalid",
      reason: "bundle content does not hash to the expected contentHash",
    };
  }
  return verifyZkmlProof(bundle.proof, expected);
}

// ── Buyer-layer auto-release predicate ───────────────────────────────────────────

/** The submitted deliverable as the Buyer's review reads it off the escrow read model. */
export type ZkmlDeliverable = ReviewDeliverable;

/** A release decision: release, and if not, whether to contest via dispute. */
export type ZkmlReviewResult = ReviewResult;

/** A named release policy the Buyer's review wires in; `evaluate` may be sync or async. */
export type ZkmlReviewPolicy = ReviewPolicy;

/** Options for {@link zkmlProofAutoRelease}. */
export interface ZkmlProofAutoReleaseOptions {
  /**
   * Fetch the bundle document the submitted `proofUri` names. Required: the content and
   * its proof come only from that document. A throw or rejection propagates (retried),
   * never a verdict.
   */
  resolveProofUri: ResolveProofUri;
  /** The model the Buyer hired; the proof's modelCommitment must equal it. */
  modelCommitment: string;
  /** The Buyer's commitment over its own spec ({@link computeZkmlInputCommitment}). */
  inputCommitment: string;
  /**
   * The proof verifier. DEFAULT is {@link verifyZkmlProof}, the reference verifier, which
   * is NOT cryptographically sound. A production buyer MUST pass a real SNARK/STARK
   * verifier here; the default is for demos only.
   */
  verify?: (proof: ZkmlProof, expected: ZkmlExpectation) => ZkmlVerification;
}

function adapterConfigError(message: string): EscroError {
  return new EscroError(message, "ADAPTER_CONFIG_ERROR");
}

function dispute(reason: string): ZkmlReviewResult {
  return { accept: false, dispute: true, reason };
}

/**
 * Buyer-layer auto-release predicate for zk-verified jobs. It resolves `proofUri` through
 * `resolveProofUri` to the pinned bundle, requires the bundle's content to re-hash to the
 * worker-submitted `contentHash`, and requires the proof's output, model and input to equal
 * that hash, the pinned model and the Buyer's input commitment (checked here, whatever
 * `verify` returns); `verify` then decides. Anything else DISPUTES. Disputing rather than
 * holding is deliberate -- a held SUBMITTED escrow is auto-released to the worker by the
 * 24h protocol timeout, so a buyer who required a proof contests a missing/invalid one
 * instead of letting it time out to release. This is the Buyer's judgment, not the
 * protocol's. Soundness lives in the `verify` option; the default reference verifier is a
 * demo and proves nothing on its own. A resolver that throws PROPAGATES: a transient infra
 * failure is not a verdict, so the caller retries it -- it is never silently converted into
 * a dispute. Construction throws `ADAPTER_CONFIG_ERROR` when a required option is missing.
 */
export function zkmlProofAutoRelease(opts: ZkmlProofAutoReleaseOptions): ZkmlReviewPolicy {
  // A JavaScript caller can pass no options at all; that is a config error, not a TypeError.
  const raw: unknown = opts;
  const given = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof ZkmlProofAutoReleaseOptions, unknown>
  >;
  if (typeof given.resolveProofUri !== "function") {
    throw adapterConfigError("zkmlProofAutoRelease: `resolveProofUri` must be a function");
  }
  for (const name of ["modelCommitment", "inputCommitment"] as const) {
    const value = given[name];
    if (typeof value !== "string" || value === "") {
      throw adapterConfigError(`zkmlProofAutoRelease: \`${name}\` must be a non-empty string`);
    }
  }
  const { resolveProofUri, modelCommitment, inputCommitment } = opts;
  const verify = opts.verify ?? verifyZkmlProof;
  return {
    name: "zkml-proof-auto-release",
    async evaluate(d: ZkmlDeliverable): Promise<ZkmlReviewResult> {
      if (d.proofUri === null || d.proofUri === "") {
        return dispute("no proofUri attached");
      }
      const bundle = decodeZkmlProofUri(await resolveProofUri(d.proofUri));
      if (bundle === null) {
        return dispute("proofUri does not resolve to a decodable zkml bundle");
      }
      const recomputed = sha256Hex(bundle.content);
      if (recomputed !== d.contentHash) {
        return dispute(
          "bundle content does not hash to the submitted contentHash (tampered or wrong)",
        );
      }
      if (bundle.proof.outputHash !== recomputed) {
        return dispute("zkml proof attests a different output than the bundle content");
      }
      if (bundle.proof.modelCommitment !== modelCommitment) {
        return dispute("zkml proof attests a different model than the pinned one");
      }
      if (bundle.proof.inputCommitment !== inputCommitment) {
        return dispute("zkml proof attests a different input than the buyer's commitment");
      }
      const verdict = verify(bundle.proof, {
        contentHash: recomputed,
        modelCommitment,
        inputCommitment,
      });
      if (verdict.valid) {
        return {
          accept: true,
          dispute: false,
          reason: "zkml proof verified against the re-hashed bundle content",
        };
      }
      return dispute(`zkml proof ${verdict.category}: ${verdict.reason}`);
    },
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────────────

/** What an inference run yields: the output plus the commitments the proof binds. */
export interface ZkmlInferenceOutput {
  /** The deliverable content. */
  content: string;
  /** Commitment to the model that produced `content`. */
  modelCommitment: string;
  /** Commitment to the input the model was run on. */
  inputCommitment: string;
}

/** Configuration and injectable ports for {@link createZkmlAdapter}. */
export interface ZkmlAdapterConfig {
  /** Adapter id. Defaults to `"zkml"`. */
  id?: string;
  /** Advertised capabilities for EscroBots discovery. Defaults to `["zk-verified-inference"]`. */
  capabilities?: string[];
  /** Inference port. Default: solves the canned demo job; a deterministic placeholder otherwise. */
  runInference?: (spec: TaskSpec) => Promise<ZkmlInferenceOutput> | ZkmlInferenceOutput;
  /** Proving port. Default: builds a reference proof binding the output to its commitments. */
  prove?: (args: {
    spec: TaskSpec;
    output: ZkmlInferenceOutput;
    outputHash: string;
  }) => Promise<ZkmlProof> | ZkmlProof;
  /**
   * Pinning port: receives the bundle document ({@link encodeZkmlProofUri}) and returns its
   * reference. Default: `ipfs://placeholder-<16 hex of the document's sha256>`, which stores
   * nothing; a production worker pins the document to IPFS/Arweave.
   */
  pin?: (document: string) => Promise<string> | string;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

/**
 * The canned zk-verified-inference demo job: a deterministic
 * classification the buyer template's demo journey hires this bot for.
 * Acceptance is machine-checkable by the buyer via {@link zkmlProofAutoRelease}.
 */
export const zkmlDemoJobSpec: TaskSpec = {
  version: "1.0.0",
  taskType: "custom",
  description:
    "Run the canned zk-verified inference demo: classify the fixed demo input and " +
    "attach a proof that the output is the correct result of the committed model on " +
    "the committed input. Acceptance is deterministic and recomputed by the buyer: the " +
    "attached proof must verify against the submitted deliverable's contentHash.",
  acceptanceCriteria: [
    {
      id: "ac-proof-verifies",
      description:
        "The attached proof verifies against the submitted deliverable's contentHash, recomputed by the buyer.",
      required: true,
    },
  ],
  deliverableFormat: { type: "json" },
  metadata: { demo: ZKML_DEMO_MARKER },
};

/** Commitment to the demo model: the value a buyer of the demo job pins. */
export const ZKML_DEMO_MODEL_COMMITMENT = sha256Hex("zkml-demo-classifier-v1");

/** The buyer's commitment over its own spec: the `inputCommitment` a proof must attest. */
export function computeZkmlInputCommitment(spec: TaskSpec): string {
  return sha256Hex(canonicalize(spec));
}

/**
 * The reference solution to the demo job: the classifier's output as canonical JSON.
 * Deterministic. Exposed so the demo journey and tests share one source of truth.
 */
export function solveZkmlDemo(): string {
  return canonicalize({
    model: "zkml-demo-classifier-v1",
    output: { label: "cat", confidence: 0.98 },
  });
}

function referencePlaceholderOutput(spec: TaskSpec): ZkmlInferenceOutput {
  return {
    content: canonicalize({
      note: "reference stub - replace the runInference port with a real zk-verified inference call.",
      taskType: spec.taskType,
    }),
    modelCommitment: sha256Hex("zkml-reference-stub-model"),
    inputCommitment: computeZkmlInputCommitment(spec),
  };
}

const defaultRunInference = (spec: TaskSpec): ZkmlInferenceOutput =>
  spec.metadata.demo === ZKML_DEMO_MARKER
    ? {
        content: solveZkmlDemo(),
        modelCommitment: ZKML_DEMO_MODEL_COMMITMENT,
        inputCommitment: computeZkmlInputCommitment(spec),
      }
    : referencePlaceholderOutput(spec);

/**
 * Build a ZKML {@link ServiceAdapter}. `execute` pins the bundle of the delivered content and
 * its proof and returns that document's reference as `proofUri`. Passes
 * `assertServiceAdapterContract` with the default ports; the default pin stores nothing, so
 * a release needs a real pin and the buyer's `resolveProofUri` in {@link zkmlProofAutoRelease}.
 * Supply real ports (a genuine inference call, a real prover, a pin to IPFS/Arweave) for
 * production use.
 */
export function createZkmlAdapter(config: ZkmlAdapterConfig = {}): ServiceAdapter {
  const id = config.id ?? ZKML_ADAPTER_ID;
  const capabilities = config.capabilities ?? [...ZKML_CAPABILITIES];
  const runInference = config.runInference ?? defaultRunInference;
  const prove =
    config.prove ??
    ((args: { output: ZkmlInferenceOutput; outputHash: string }): ZkmlProof =>
      buildZkmlProof({
        modelCommitment: args.output.modelCommitment,
        inputCommitment: args.output.inputCommitment,
        outputHash: args.outputHash,
      }));
  const pin =
    config.pin ??
    ((document: string): string => `ipfs://placeholder-${sha256Hex(document).slice(0, 16)}`);
  const checkHealth = config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true));

  return {
    id,
    capabilities,
    async execute(spec: TaskSpec): Promise<ServiceResult> {
      const output = await runInference(spec);
      const contentHash = sha256Hex(output.content);
      const proof = await prove({ spec, output, outputHash: contentHash });
      const proofUri = await pin(encodeZkmlProofUri({ content: output.content, proof }));
      return {
        content: output.content,
        contentHash,
        proofUri,
        metadata: {
          adapterId: id,
          scheme: proof.scheme,
          modelCommitment: proof.modelCommitment,
        },
      };
    },
    healthCheck(): Promise<boolean> {
      return checkHealth();
    },
  };
}
