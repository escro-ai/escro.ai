// The Buyer's review shapes: defined once here; @escro/sdk publishes them as
// ZkmlDeliverable, ZkmlReviewResult and ZkmlReviewPolicy, and the create-escro-bot buyer
// template imports those names. Escro never judges the deliverable: these carry the Buyer's
// own decision.

/** The submitted deliverable as the Buyer's review reads it off the escrow read model. */
export interface ReviewDeliverable {
  /**
   * SHA-256 hex the worker submitted on-chain (mirrored to the read model). It is the
   * worker's claim about the artifact: a review re-hashes the real artifact and never
   * trusts this value on its own.
   */
  contentHash: string;
  /** URI the worker gave for the deliverable or its proof, or null if it gave none. */
  proofUri: string | null;
}

/** A release decision. */
export interface ReviewResult {
  /** Release payment to the worker. */
  accept: boolean;
  /**
   * When NOT accepting, whether to raise a dispute (human arbitration) rather than hold.
   * A held SUBMITTED escrow is auto-released to the worker by the 24h protocol timeout,
   * so a real reject predicate disputes to contest.
   */
  dispute: boolean;
  reason: string;
}

/** A named release policy the Buyer's review wires in. */
export interface ReviewPolicy {
  name: string;
  evaluate(deliverable: ReviewDeliverable): ReviewResult | Promise<ReviewResult>;
}
