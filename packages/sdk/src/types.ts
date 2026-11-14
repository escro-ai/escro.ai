import type { Keypair } from "@solana/web3.js";
import type { BotDescriptor, EscrowAccount, SolanaCluster, TaskSpec } from "@escro/shared";
import type { EscroConfirmError } from "./errors.js";

/** Constructor options for the {@link Escro} client. */
export interface EscroOptions {
  /**
   * Which Solana cluster this client talks to. Required so the program ID and
   * USDC mint resolve correctly. Pass `"devnet"` for testing, `"mainnet"` for
   * production.
   */
  cluster: SolanaCluster;
  /** Solana RPC endpoint URL. */
  rpcUrl: string;
  /** Escro REST API base URL (e.g. "https://api.escro.ai"). */
  apiUrl: string;
  /** Ed25519 keypair used to sign transactions and API requests. */
  wallet: Keypair;
  /**
   * The most micro-USDC this wallet may hold locked in open escrows, each counted as its
   * deposit: amount plus fee. {@link Escro.createEscrow} refuses (`SPEND_CAP_EXCEEDED`), before
   * the create is sent, a create whose deposit would pass it. Required for `createEscrow` on
   * `"mainnet"`, which refuses without it; the other methods never read it. Copied at
   * construction.
   *
   * Outstanding is the API's total of the wallet's FUNDED, IN_PROGRESS, SUBMITTED and DISPUTED
   * deposits (one `GET /v1/escrows/outstanding` per create), plus this process's own creates in
   * flight: a create holds its deposit from the API's answer to its POST. A create that throws
   * before its transaction is sent (the SDK's refusal of the server's transaction as not the
   * create it asked for, `UNEXPECTED_TRANSACTION`; an undecodable server transaction; a failed
   * blockhash read) holds nothing. Once sent, the hold lasts until a successful
   * {@link Escro.confirm} of its address, until a later create's admission reads the escrow from
   * the API (one `GET /v1/escrows/:address` per create in flight; a read that fails keeps the
   * hold and refuses nothing), or until evidence shows the transaction never took effect: the
   * RPC rejected it (a `SendTransactionError`) other than as already processed, or it failed at
   * execution (`TX_FAILED`, from the send's confirmation or a confirm). A create that throws
   * after its transaction is sent for any other reason (a transport error, a confirmation
   * timeout, an `EscroConfirmError`) keeps counting, and shrinks the cap's room, until
   * `confirm(address, signature)` succeeds or the process exits. An "already processed" rejection carries no signature to confirm with, so its
   * hold lasts until the process exits. An outstanding read that fails, answers something
   * malformed or takes longer than 15 s refuses the create (`SPEND_CAP_UNREADABLE`, a failed or
   * timed-out read as its `cause`); a PlatformConfig read that fails or takes longer than 15 s
   * throws its own error, with no code.
   *
   * The cap holds per process: every capped `Escro` for one wallet and cluster in the process
   * shares one admission queue and one in-flight set. Two processes or hosts on one wallet each
   * enforce it and together can pass it by the other's in-flight deposits; run one buyer process
   * per wallet, or give each process its share.
   */
  spendCap?: {
    /** The cap, in integer micro-USDC (1 USDC = 1_000_000); deposits equal to it are allowed. */
    maxOutstandingMicroUsdc: number;
    /**
     * Replaces the API read: the micro-USDC already locked in this wallet's open escrows,
     * deposits counted. The process's in-flight creates are added to its answer. Called with the
     * `spendCap` object given at construction as `this`. Bound like the API read: one that has
     * not answered within 15 s is abandoned (it is passed no signal, so it is not cancelled) and
     * the create refused with `SPEND_CAP_UNREADABLE`.
     */
    outstanding?: () => Promise<number>;
  };
  /**
   * The most micro-USDC {@link Escro.pay} may spend over the x402 rail, separate from
   * {@link EscroOptions.spendCap}: neither cap draws on the other. Required for an `exact` payment
   * on `"mainnet"`, which refuses without it (`SPEND_CAP_REQUIRED`); a payment that would pass it
   * refuses (`SPEND_CAP_EXCEEDED`). Copied at construction.
   *
   * A payment counts at its full amount from admission, before it is signed, and is credited back
   * only if it is refused before its signature exists: once signed it stays counted, because the
   * resource server can still land the transfer. The budget is per process, per cluster and wallet,
   * and RESETS WHEN THE PROCESS RESTARTS; give `spent` to carry a budget across restarts.
   */
  x402SpendCap?: {
    /** The cap, in integer micro-USDC (1 USDC = 1_000_000); spending up to it is allowed. */
    maxMicroUsdc: number;
    /**
     * The micro-USDC the operator records as already spent on this wallet's x402 rail, added to the
     * process's own total. A reader that also counts this process's payments double-counts them,
     * which refuses early and never overspends. Called with the `x402SpendCap` object given at
     * construction as `this`. One that fails, answers anything but a whole non-negative number or
     * takes longer than 15 s refuses the payment (`SPEND_CAP_UNREADABLE`).
     */
    spent?: () => Promise<number>;
  };
}

/** The {@link EscroOptions.spendCap} option. */
export type SpendCap = NonNullable<EscroOptions["spendCap"]>;

/** The {@link EscroOptions.x402SpendCap} option. */
export type X402SpendCap = NonNullable<EscroOptions["x402SpendCap"]>;

/** How a lifecycle call (create, claim, submit, cancel, dispute, release) sends its transaction. */
export interface SendOptions {
  /**
   * `true` (the default): send, wait for the transaction to confirm on chain, then have the API
   * record it. `false`: check and sign the transaction exactly as the default does, send it and
   * return its signature without waiting or notifying the API. The caller learns the outcome by
   * `getEscrow(address)` (the API records every landed transaction within about a minute plus
   * finality), by the signature's status on chain, or by
   * `confirm(address, signature)` as a hint. A dispute's evidence travels
   * only with the disputant's confirm, so `raiseDispute` with `evidence` refuses `wait: false`.
   * Under {@link EscroOptions.spendCap}, a create sent this way stays counted as in flight until
   * a later create's admission reads the escrow from the API, a confirm records it, or a confirm
   * of its signature shows it failed on chain.
   */
  wait?: boolean;
}

/** Parameters for creating a new escrow. */
export interface CreateEscrowParams {
  /** The full task specification; the API records its hash, never its body. */
  taskSpec: TaskSpec;
  /**
   * Worker's net payment in μUSDC (1 USDC = 1_000_000). Minimum: 5_000_000.
   * The buyer is charged `amountUsdc + fee` at creation; the worker receives
   * the full `amountUsdc` on settlement.
   */
  amountUsdc: number;
  /** Unix timestamp (seconds) at which the escrow deadline expires. */
  deadlineUnix: number;
  /**
   * Base-58 public key of the worker assigned to this task. Required:
   * every escrow is created against a specific worker (open tasks are
   * not supported).
   */
  assignedWorker: string;
}

/** Return value from {@link Escro.createEscrow}. */
export interface CreateEscrowResult {
  /** Task ID (32-char hex UUID without hyphens). Used internally by the API. */
  escrowId: string;
  /** Base-58 on-chain PDA address. Use this as the identifier for all subsequent calls. */
  escrowPda: string;
  /** Solana transaction signature. */
  signature: string;
}

/**
 * Return value from {@link Escro.releasePaymentWithOutcome}. The release landed on
 * chain either way; `confirm` says whether the API recorded it. A failed confirm
 * carries an `EscroConfirmError` (`address`, `signature`, `code`).
 */
export interface ReleasePaymentOutcome {
  /** Solana transaction signature of the landed `release_payment`. */
  signature: string;
  confirm: { landed: true } | { landed: false; error: EscroConfirmError };
}

/** {@link ReleasePaymentOutcome} of a predicate release, with the decision memo it carried. */
export type ReleaseWithPredicateOutcome = ReleasePaymentOutcome & { memo: string };

/** Parameters for submitting a deliverable. */
export interface SubmitDeliverableParams {
  /** SHA-256 hex digest (or content-addressed hash) of the deliverable content. */
  contentHash: string;
  /** Optional URI pointing to the deliverable artifact (IPFS, Arweave, etc.). */
  proofUri?: string;
}

/** Parameters for raising a dispute. */
export interface RaiseDisputeParams {
  /** Human-readable reason for the dispute: non-empty, at most 200 UTF-8 bytes. */
  reason: string;
  /** Optional URL to evidence supporting the dispute. */
  evidence?: string;
}

/** Options for polling methods. */
export interface PollOptions {
  /**
   * Enable polling with exponential backoff.
   * - 0 to 5 min: poll every 15 s
   * - 5 to 30 min: poll every 30 s
   * - 30 min to 24 h: poll every 60 s
   * - After 24 h: throws {@link EscrowTimeoutError}
   * @default false
   */
  poll?: boolean;
  /** Override the default 24-hour polling timeout (ms). */
  timeoutMs?: number;
}

/** Pagination parameters for list queries. */
export interface ListOptions {
  /** Maximum number of items to return. Default: 20, max: 100. */
  limit?: number;
  /** Zero-based offset for pagination. Default: 0. */
  offset?: number;
}

/** Paginated response wrapper. */
export interface PaginatedResult<T> {
  /** The requested page of items. */
  items: T[];
  /** Total number of items matching the query (ignoring pagination). */
  total: number;
  /** The effective limit applied to this response. */
  limit: number;
  /** The effective offset applied to this response. */
  offset: number;
}

/** Serialized form of EscrowAccount as returned over HTTP (amount is a string). */
export type SerializedEscrow = Omit<EscrowAccount, "amount"> & { amount: string };

/** Filters for an EscroBots registry read (`GET /v1/bots`). */
export interface ListBotsParams {
  /** Free-form capability tag to filter by, e.g. `"fine-tune"`. */
  capability?: string;
  /** Role filter. `worker` includes `both` bots (a `both` bot is hireable as a worker). */
  role?: BotDescriptor["role"];
  /** Maximum number of descriptors to return. */
  limit?: number;
  /** Zero-based offset for pagination. */
  offset?: number;
}

/**
 * One candidate returned by {@link Escro.findWorkers}. The `descriptor` is a
 * self-reported CLAIM; `signatureValid` attests only that the
 * claim was genuinely signed by `descriptor.wallet` (authorship), NOT that its
 * capabilities are true. On-chain history (EscroRep) is the verification
 * of the claim, deliberately kept separate here, never merged into one flag.
 */
export interface WorkerCandidate {
  /** The wallet-signed capability descriptor as served by the registry (a claim). */
  descriptor: BotDescriptor;
  /** True iff `descriptor.signature` verifies against `descriptor.wallet` (authorship only). */
  signatureValid: boolean;
}
