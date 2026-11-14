import type { TaskSpec } from "@escro/shared";

import type { SubmitDeliverableParams } from "./types.js";

/**
 * The result a {@link ServiceAdapter} returns from `execute`. Escro is agnostic
 * to what produced it: `content` is the deliverable itself, `contentHash` is the
 * SHA-256 hex digest the Buyer verifies the deliverable against, and `proofUri`
 * optionally points at where the content is pinned (IPFS/Arweave) or at a proof.
 * No currency or token field appears here; token conversion is adapter-internal,
 * since the escrow vault holds USDC only.
 */
export interface ServiceResult {
  /** The deliverable itself. */
  content: string | Buffer;
  /** SHA-256 hex digest of {@link ServiceResult.content}. */
  contentHash: string;
  /** Content-addressed URI (ipfs://, ar://) or proof URI for the deliverable. */
  proofUri?: string;
  /** Arbitrary adapter-specific metadata (model, timings, subnet ids, ...). */
  metadata: Record<string, unknown>;
}

/**
 * A Worker Bot implements ServiceAdapter to wrap any async service (a Bittensor
 * subnet, an Akash deployment, a Render job, ...). Escro never sees what is
 * underneath and never sees a non-USDC token: the adapter handles any token
 * conversion internally. Every pre-built adapter reuses
 * this interface and is validated by `assertServiceAdapterContract`.
 */
export interface ServiceAdapter {
  /** Stable identifier, e.g. "bittensor:sn56", "akash", "render". */
  id: string;
  /** Advertised capabilities, e.g. ["llm_inference", "image_gen"]. */
  capabilities: string[];
  /** Execute the task described by `spec` and return the deliverable. */
  execute(spec: TaskSpec): Promise<ServiceResult>;
  /** Report whether the underlying service is reachable and ready. */
  healthCheck(): Promise<boolean>;
}

/**
 * The buyer's port that fetches the bytes a `proofUri` names (an IPFS or Arweave gateway,
 * a storage bucket). A throw or rejection is an infrastructure failure that propagates to
 * the caller, which retries it; it is never a verdict on the deliverable.
 */
export type ResolveProofUri = (proofUri: string) => Promise<string | Buffer> | string | Buffer;

/**
 * Map a {@link ServiceResult} onto {@link SubmitDeliverableParams}, surfacing the
 * `contentHash` (and `proofUri`, when present) that `submit_deliverable` records.
 * This is the single point where an adapter's output crosses into the escrow
 * worker flow.
 */
export function serviceResultToSubmitParams(result: ServiceResult): SubmitDeliverableParams {
  return {
    contentHash: result.contentHash,
    ...(result.proofUri !== undefined && { proofUri: result.proofUri }),
  };
}
