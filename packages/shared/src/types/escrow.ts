import type { SolanaCluster } from "../config.js";

/**
 * Lifecycle states of an escrow, each transition validated by the on-chain program.
 *
 * Happy path: FUNDED → IN_PROGRESS → SUBMITTED → COMPLETED (buyer release or the 24h
 * timeout release).
 *
 * Exception paths:
 * IN_PROGRESS | SUBMITTED → DISPUTED (resolved only by arbitration, to COMPLETED or REFUNDED)
 * FUNDED → CANCELLED (buyer cancels before the claim; on chain the account is REFUNDED)
 * FUNDED | IN_PROGRESS → REFUNDED (deadline plus grace passed before a submission)
 */
export enum EscrowState {
  /**
   * An unconfirmed intent: the API's create build recorded it and no landed create_escrow has
   * funded it yet. Never persisted on chain and never served by a read.
   */
  CREATED = "CREATED",
  /** Maker deposited tokens into the vault; open for agent acceptance. */
  FUNDED = "FUNDED",
  /** An agent accepted the task; work is underway. */
  IN_PROGRESS = "IN_PROGRESS",
  /** Agent submitted a deliverable URI; awaiting buyer review or 24h auto-release. */
  SUBMITTED = "SUBMITTED",
  /** Funds released to the agent. Terminal state. */
  COMPLETED = "COMPLETED",
  /** Buyer cancelled before work started. Terminal state. */
  CANCELLED = "CANCELLED",
  /** Maker or agent raised a dispute; requires human arbitration. */
  DISPUTED = "DISPUTED",
  /** Funds returned to the maker (deadline expiry or dispute resolution). Terminal state. */
  REFUNDED = "REFUNDED",
}

/** Solana cluster the escrow account lives on. */
export type Network = "mainnet-beta" | "devnet" | "localnet";

/**
 * Full on-chain representation of an AgentEscrow PDA, enriched with
 * off-chain metadata resolved by the API server.
 *
 * `amount` and all `*At` timestamps use the on-chain units:
 *   - `amount` is in the SPL token's smallest denomination (e.g. μUSDC = 10⁻⁶ USDC).
 *   - timestamps are Unix seconds as stored in the Anchor account.
 *
 * When serialising over HTTP (the API's escrow responses), `amount` is represented as a
 * decimal `string` of the smallest denomination to avoid JSON `number` precision loss.
 */
export interface EscrowAccount {
  /** Base-58 public key of the escrow PDA. */
  address: string;
  /** Base-58 public key of the task creator (the party paying for the work). */
  maker: string;
  /** Base-58 public key of the worker assigned at creation (every escrow has one). */
  taker: string | null;
  /** Base-58 public key of the SPL token mint used for payment (e.g. USDC mint). */
  mint: string;
  /**
   * Payment amount held in escrow, in the mint's smallest denomination.
   * Stored as `bigint` to preserve full u64 precision from the on-chain account.
   */
  amount: bigint;
  /** Current lifecycle state of the escrow. */
  state: EscrowState;
  /**
   * SHA-256 hex digest of the canonical UTF-8 JSON serialisation of the {@link TaskSpec}.
   * Recorded on-chain (the account's `spec_hash` holds this hash, bare, or as `ipfs://<hash>` on
   * older escrows), so the buyer and worker (and an arbitrator) can check that a
   * spec is the one the escrow was created for.
   */
  taskSpecHash: string;
  /**
   * The exact string the escrow's on-chain `spec_hash` holds: the bare 64-hex `taskSpecHash`
   * (current creates), `ipfs://<taskSpecHash>` (older escrows), or `null` where the API's record
   * of an older escrow lacks it. A label for the {@link TaskSpec}'s hash, not a fetchable copy
   * (Escro stores no spec body; the buyer shares the spec).
   */
  taskSpecUri: string | null;
  /**
   * Base-58 public key of the oracle authority permitted to sign timeout_release
   * (refund_buyer is permissionless).
   */
  oracle: string;
  /**
   * Platform fee in basis points. Once the API has read the escrow's `create_escrow` from chain,
   * it serves the escrow's on-chain `fee_bps` from its `EscrowCreated` event (PlatformConfig's
   * value, stored per escrow at creation); on a CREATED intent not yet read it serves its
   * `PLATFORM_FEE_BPS` mirror. Additive: the buyer deposits `amount` plus the fee and the
   * worker receives the full `amount`.
   */
  oracleFeeBps: number;
  /** Unix timestamp (seconds) when the escrow PDA was initialised. */
  createdAt: number;
  /**
   * Unix timestamp (seconds) at which the escrow deadline expires; mirrors the
   * on-chain `deadline` field set at `create_escrow`. A Worker Bot reads this to
   * decide whether it can finish a job before the deadline (never claim what it
   * can't finish); after it passes, an unstarted escrow is refundable to the maker.
   */
  deadline: number;
  /** Unix timestamp (seconds) of the most recent agent submission, or `null`. */
  submittedAt: number | null;
  /**
   * SHA-256 hex digest of the worker's submitted deliverable, mirrored from the
   * on-chain `deliverable_hash` written at `submit_deliverable`; `null` until the
   * escrow reaches SUBMITTED. The on-chain value is authoritative: a Buyer Bot's
   * review re-verifies a deliverable against a hash it independently expects and
   * never treats this mirror as proof of integrity on its own.
   */
  deliverableHash: string | null;
  /**
   * URI of the submitted deliverable artifact (S3 presigned / IPFS / Arweave),
   * mirrored from the off-chain `proof_uri` recorded at `submit_deliverable`;
   * `null` until SUBMITTED. The Buyer Bot fetches the deliverable content here to
   * review it.
   */
  proofUri: string | null;
  /** PDA canonical bump seed, stored on-chain to validate future instructions. */
  bump: number;
  /** Solana cluster this account belongs to. */
  network: Network;
}

/**
 * `GET /v1/escrows/outstanding?maker=`: the maker's open deposits, the escrows whose vault still
 * holds the buyer's money (FUNDED, IN_PROGRESS, SUBMITTED, DISPUTED; never CREATED).
 */
export interface OutstandingDeposits {
  /** Base-58 public key of the buyer the figures are for. */
  maker: string;
  /** Number of open escrows counted. */
  count: number;
  /**
   * Sum over those escrows of `amount` plus the program's fee at the escrow's stored rate, in
   * micro-USDC, as a decimal u64 string (it can exceed `Number.MAX_SAFE_INTEGER`).
   */
  depositsMicroUsdc: string;
}

/**
 * First-class settlement cause for an escrow, recorded off-chain (EscroRep
 * fidelity). One value per fund-moving instruction, keyed 1:1 to the
 * EscroRep reducer's `EscrowEventKind` so the reputation the API serves
 * matches the on-chain reducer. The cause also encodes the dispute OUTCOME:
 * `ARBITRATION_RELEASE` = worker prevailed, `ARBITRATION_REFUND` = buyer
 * prevailed. Single-sourced here: whatever stores or validates a cause accepts
 * exactly this list; never caller-supplied.
 *
 * Declared as a `const` array (not a bare union) so the value list has a single
 * runtime source any test or validator reads from.
 */
export const SETTLEMENT_CAUSES = [
  /** Buyer-signed release_payment: explicit completion. */
  "EXPLICIT_RELEASE",
  /** Oracle timeout_release: 24h auto-release completion (buyer non-response). */
  "TIMEOUT_RELEASE",
  /** admin arbitration_release: worker prevailed in a dispute, not a completion. */
  "ARBITRATION_RELEASE",
  /** Deadline-expiry refund_buyer (any cranker): worker non-delivery. */
  "DEADLINE_REFUND",
  /** admin arbitration_refund: buyer prevailed in a dispute. */
  "ARBITRATION_REFUND",
  /** cancel_escrow: buyer cancelled a FUNDED escrow before any claim. */
  "CANCELLED",
] as const;

/** The settlement cause recorded for a settled escrow (see {@link SETTLEMENT_CAUSES}). */
export type SettlementCause = (typeof SETTLEMENT_CAUSES)[number];

/**
 * Every outcome the oracle records for a settlement it attempts. Single-sourced
 * here: the oracle's recorder takes an {@link OracleEventType}, and whatever
 * accepts a recorded outcome must accept every value here (it may also keep
 * retired values nothing records any more).
 *
 * Declared as a `const` array (not a bare union) so the value list has a single
 * runtime source any test or validator reads from.
 */
export const ORACLE_EVENT_TYPES = [
  /** Oracle-signed timeout_release settled the escrow (24h auto-release completion). */
  "TIMEOUT_RELEASE",
  /** Permissionless refund_buyer settled the escrow (deadline-expiry refund). */
  "AUTO_REFUND",
  /** A repeated settlement request: the escrow was already settled, nothing signed. */
  "ALREADY_SETTLED",
  /**
   * An escrow recorded off-chain as DISPUTED, whose dispute never landed on chain, was restored to
   * its on-chain state.
   */
  "DISPUTE_RECONCILED",
  /** A closed escrow's off-chain record was brought to its actual on-chain settlement. */
  "RECONCILED",
  /** A closed escrow's settling instruction could not be read, so no settlement was recorded. */
  "RECONCILE_INDETERMINATE",
  /** Settlement attempted before its on-chain time gate opened (silent backoff, not a failure). */
  "NOT_YET_ELIGIBLE",
  /** A request of an unknown or forged type was dropped (the oracle acts only on its own types). */
  "UNKNOWN_MESSAGE_TYPE",
] as const;

/** An outcome the oracle records (see {@link ORACLE_EVENT_TYPES}). */
export type OracleEventType = (typeof ORACLE_EVENT_TYPES)[number];

/** One set of `GET /v1/stats` figures: the public block, or the operator block. */
export interface ProtocolStatsFigures {
  totalEscrows: number;
  totalVolumeUsdc: string;
  /**
   * Settled USDC volume: the sum of `amount_usdc` (the job amount, which the
   * worker keeps in full; the additive platform fee is protocol revenue, not
   * settled work volume) over escrows in the COMPLETED terminal state. COMPLETED
   * is reached only by the three worker-paying instructions (release_payment,
   * timeout_release, arbitration_release); refunded and cancelled escrows never
   * paid a worker and are excluded. This is the honest headline number: it counts
   * settlement, not transaction volume.
   */
  settledVolumeUsdc: string;
  byState: Record<EscrowState, number>;
  activeEscrows: number;
}

/** Protocol-wide aggregate statistics: public, unauthenticated. */
export interface ProtocolStats extends ProtocolStatsFigures {
  /** The Solana cluster this API serves (its `CLUSTER`). */
  cluster: SolanaCluster;
  /** That cluster's one USDC mint (`getUsdcMint`): every figure here is in this token. */
  usdcMint: string;
  /**
   * Escro-operated fleet figures: the same fields over
   * escrows whose buyer and assigned worker are both in the API's operator
   * allowlist. They are real settlements but not third-party demand, so every
   * public field excludes them; never sum this block with the public fields.
   */
  operator: ProtocolStatsFigures;
}

/** One worker's settled earnings over an activity window; wallet anonymised. */
export interface ActivityEarner {
  /**
   * Anonymised worker wallet: a truncated display form (`first4...last4`), never
   * the full address. Truncation is a display convenience, not a privacy boundary
   * (Solana addresses are public and EscroRep exposes full per-wallet history).
   */
  wallet: string;
  /** Settled USDC (job amount) the worker earned in the window. */
  settledVolumeUsdc: string;
  /** Number of escrows the worker settled (reached COMPLETED) in the window. */
  jobsSettled: number;
}

/**
 * Activity leaderboard: anonymised top earners over a rolling window. The data
 * source behind escro.ai/activity (weekly earners). Public, unauthenticated.
 */
export interface ActivityLeaderboard {
  /** The Solana cluster this API serves (its `CLUSTER`). */
  cluster: SolanaCluster;
  /** That cluster's one USDC mint (`getUsdcMint`): every earning here is in this token. */
  usdcMint: string;
  /** Rolling window length in days (7 = weekly earners). */
  periodDays: number;
  /** Top earners, descending by settled volume. */
  earners: ActivityEarner[];
}
