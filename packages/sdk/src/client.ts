import { Connection, PublicKey, SendTransactionError } from "@solana/web3.js";
import {
  computeTaskSpecHash,
  disputeReasonError,
  escrowFee,
  getCaip2Network,
  isSafeUrl,
  verifyBotDescriptorSignature,
} from "@escro/shared";
import type {
  EscrowAccount,
  EscrowErrorCode,
  EscrowState,
  ProtocolStats,
  SolanaCluster,
} from "@escro/shared";
import { isCanonicalPubkey } from "@escro/shared/solana";
import type { ServedWalletReputation } from "./reputation-types.js";
import type {
  CreateEscrowParams,
  CreateEscrowResult,
  EscroOptions,
  ListOptions,
  PaginatedResult,
  PollOptions,
  RaiseDisputeParams,
  ReleasePaymentOutcome,
  ReleaseWithPredicateOutcome,
  SendOptions,
  SpendCap,
  SubmitDeliverableParams,
  WorkerCandidate,
  X402SpendCap,
} from "./types.js";
import { ApiClient } from "./api.js";
import { EscroConfirmError, EscroError, EscrowNotFoundError, attachToError } from "./errors.js";
import { EscrowPaymentRouter } from "./payments.js";
import type { PayParams, PaymentResult, PaymentRouter } from "./payments.js";
import { pollUntil } from "./poll.js";
import { assertPublicKey } from "./public-key.js";
import { payOver402 } from "./x402/pay.js";
import {
  SPEND_CAP_ERROR_CODES,
  admit,
  assertWithinSpendCap,
  boundedRead,
  dropFailed,
  dropPending,
  isMicroUsdc,
  outstandingFromAnswer,
  pendingMicroUsdc,
  recordSent,
  walletLedger,
  type WalletLedger,
} from "./spend-cap.js";
import {
  buildReleasePaymentTx,
  fetchPlatformConfig,
  resolveProgramId,
  signAndSend,
  type ExpectedTransaction,
} from "./solana.js";
import { ChainReadError, decodeEscrowAccount } from "./chain-read.js";
import { predicateMemo, type DecisionJob, type PredicateResult } from "./predicates/index.js";

// How long {@link Escro.confirm} keeps retrying a not-yet-visible transaction.
const CONFIRM_WINDOW_MS = 30_000;
const CONFIRM_FIRST_DELAY_MS = 500;
const CONFIRM_MAX_DELAY_MS = 4_000;
// Codes worth retrying: the transaction is not visible yet, the RPC failed, a
// gateway answered without a server code (502/503/504 from the load balancer),
// or a rate limit (confirm is idempotent).
const RETRYABLE_CONFIRM_CODES = [
  "TX_NOT_FOUND",
  "RPC_UNAVAILABLE",
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
  "RATE_LIMITED",
  "HTTP_429",
] as const;

function isRetryableConfirmCode(code: string): boolean {
  return (RETRYABLE_CONFIRM_CODES as readonly string[]).includes(code);
}

// A release the API's RPC cannot yet see as settled is refused, retryable.
function isRetryableReleaseCode(code: string): boolean {
  return code === ("ESCROW_NOT_SETTLED" satisfies EscrowErrorCode) || isRetryableConfirmCode(code);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Evidence that a sent create never took effect on chain, so its deposit is not in flight: the
// RPC refused it for a reason other than its having been processed already, or it landed and
// failed at execution. Anything else after the send (a transport error, a confirmation timeout,
// "already processed") may have landed, so the deposit stays counted.
function neverLanded(err: unknown): boolean {
  if (err instanceof SendTransactionError) {
    return !/already been processed/i.test(err.transactionError.message);
  }
  return err instanceof EscroError && err.code === ("TX_FAILED" satisfies EscrowErrorCode);
}

export class Escro {
  private readonly connection: Connection;
  private readonly api: ApiClient;
  private readonly options: EscroOptions;
  private readonly cluster: SolanaCluster;
  private readonly router: PaymentRouter = new EscrowPaymentRouter();
  private readonly spendCap: Readonly<SpendCap> | undefined;
  private readonly x402SpendCap: Readonly<X402SpendCap> | undefined;

  constructor(options: EscroOptions) {
    const cap = options.spendCap;
    if (cap !== undefined && !isMicroUsdc(cap.maxOutstandingMicroUsdc)) {
      throw new EscroError(
        `spendCap.maxOutstandingMicroUsdc must be a whole, non-negative micro-USDC amount: ${String(cap.maxOutstandingMicroUsdc)}`,
        "VALIDATION_ERROR",
      );
    }
    this.spendCap =
      cap === undefined
        ? undefined
        : Object.freeze({
            maxOutstandingMicroUsdc: cap.maxOutstandingMicroUsdc,
            ...(cap.outstanding !== undefined && { outstanding: cap.outstanding.bind(cap) }),
          });
    const x402Cap = options.x402SpendCap;
    if (x402Cap !== undefined && !isMicroUsdc(x402Cap.maxMicroUsdc)) {
      throw new EscroError(
        `x402SpendCap.maxMicroUsdc must be a whole, non-negative micro-USDC amount: ${String(x402Cap.maxMicroUsdc)}`,
        "VALIDATION_ERROR",
      );
    }
    this.x402SpendCap =
      x402Cap === undefined
        ? undefined
        : Object.freeze({
            maxMicroUsdc: x402Cap.maxMicroUsdc,
            ...(x402Cap.spent !== undefined && { spent: x402Cap.spent.bind(x402Cap) }),
          });
    this.options = options;
    this.cluster = options.cluster;
    this.connection = new Connection(options.rpcUrl, "confirmed");
    this.api = new ApiClient(options.apiUrl, options.wallet);
  }

  /**
   * Create a new escrow: registers with the API, signs and submits the
   * on-chain `create_escrow` transaction, then confirms it with the API.
   * Before any request it refuses (`VALIDATION_ERROR`) an `assignedWorker` that is not a
   * base-58 public key or an `amountUsdc` that is not a positive whole number and, on
   * `"mainnet"`, a client constructed without the `spendCap` option (`SPEND_CAP_REQUIRED`).
   * With a `spendCap` it refuses (`SPEND_CAP_EXCEEDED`), before the create is sent, a create
   * whose deposit would pass the cap; see {@link EscroOptions.spendCap}. With
   * `{ wait: false }` it returns once the create is sent; see {@link SendOptions.wait}.
   * An error thrown after the transaction was handed to the RPC, unless it shows the transaction
   * never took effect, is the original error with two own string properties set, `escrowPda` and
   * `signature`: the create may have landed, and those name it. A rejection that is not an `Error`
   * becomes a new `Error` carrying the two properties, with the original value as its `cause`.
   *
   * @returns `{ escrowId, escrowPda, signature }`; use `escrowPda` for all subsequent calls.
   */
  async createEscrow(
    params: CreateEscrowParams,
    options?: SendOptions,
  ): Promise<CreateEscrowResult> {
    const wait = options?.wait ?? true;
    if (!isCanonicalPubkey(params.assignedWorker)) {
      throw new EscroError(
        `assignedWorker must be a base-58 public key: ${JSON.stringify(params.assignedWorker)}`,
        "VALIDATION_ERROR",
      );
    }
    if (!Number.isSafeInteger(params.amountUsdc) || params.amountUsdc <= 0) {
      throw new EscroError(
        `amountUsdc must be a positive whole micro-USDC amount: ${String(params.amountUsdc)}`,
        "VALIDATION_ERROR",
      );
    }
    const cap = this.spendCap;
    if (cap === undefined && this.cluster === "mainnet") {
      throw new EscroError(
        "createEscrow on mainnet needs a spend cap: construct Escro with the spendCap option.",
        SPEND_CAP_ERROR_CODES.required,
      );
    }
    const wallet = this.options.wallet.publicKey.toBase58();
    const { escrowId, escrowPda, unsignedTx } =
      cap === undefined
        ? await this.api.createEscrow(params)
        : await this.admitCreate(cap, wallet, params);
    // Set once the transaction is handed to the RPC: a failure before then holds nothing.
    let sent = false as boolean;
    let signature: string;
    try {
      signature = await this.send(
        unsignedTx,
        {
          name: "create_escrow",
          escrowPda,
          taskId: escrowId,
          amount: BigInt(params.amountUsdc),
          deadline: BigInt(params.deadlineUnix),
          specHash: computeTaskSpecHash(params.taskSpec),
          assignedWorker: params.assignedWorker,
        },
        () => {
          sent = true;
        },
        wait,
      );
    } catch (err) {
      if (!sent || neverLanded(err)) dropPending(this.cluster, wallet, escrowPda);
      else attachToError(err, "escrowPda", escrowPda);
      throw err;
    }
    recordSent(this.cluster, wallet, escrowPda, signature);
    if (wait) await this.confirm(escrowPda, signature);
    return { escrowId, escrowPda, signature };
  }

  /**
   * Release payment to the worker. Buyer must be the wallet in the constructor.
   * Builds and submits the `release_payment` on-chain tx FIRST (the chain is the
   * source of truth), then has the API record it, retrying as
   * {@link Escro.releasePaymentWithOutcome} does. Use that method to see whether the
   * API recorded the release. With `{ wait: false }` it returns once the release is sent and
   * asks the API to record nothing; see {@link SendOptions.wait}.
   *
   * @returns Solana transaction signature.
   */
  async releasePayment(address: string, options?: SendOptions): Promise<string> {
    if (options?.wait === false) return this.sendRelease(address, false);
    const { signature } = await this.releasePaymentWithOutcome(address);
    return signature;
  }

  /**
   * {@link Escro.releasePayment}, reporting whether the API recorded the release.
   * `ESCROW_NOT_SETTLED` (the API's RPC does not yet show the escrow closed), the codes
   * {@link Escro.confirm} retries and a network failure are retried for about 30 s. A
   * failed record never throws: the release already landed, so the signature is returned
   * with `confirm.landed: false` and an `EscroConfirmError` (the API's code, or
   * `NETWORK_ERROR` when the last call never reached it). A release that failed at
   * execution on chain throws an {@link EscroError} with code `TX_FAILED`, and the API is
   * never asked to record it.
   *
   * @returns `{ signature, confirm }`.
   */
  async releasePaymentWithOutcome(address: string): Promise<ReleasePaymentOutcome> {
    return this.release(address);
  }

  /**
   * Release payment on a passing predicate result, with its decision memo
   * (`escro:predicate:<name>:pass:<record hash>`) as one SPL Memo instruction, last, in the
   * buyer's own `release_payment`. Before anything is signed it refuses, with an
   * {@link EscroError}, an `address` that is not a base-58 public key (`VALIDATION_ERROR`, before
   * any read), then a result whose decision is not `pass` (`PREDICATE_NOT_PASSED`), a record the
   * extension refuses, a record with no `job` included (`PREDICATE_RECORD`), then a record whose
   * `job` names another network (`PREDICATE_NETWORK_MISMATCH`), another program
   * (`PREDICATE_PROGRAM_MISMATCH`) or another escrow (`PREDICATE_JOB_MISMATCH`) than this
   * client's cluster and `address`, all before any read; and, from the escrow's account read on
   * chain, an escrow that is not on chain, not owned by the Escro program, not SUBMITTED, or whose
   * committed `deliverable_hash` is not the record's `deliverableHash`
   * (`PREDICATE_DELIVERABLE_MISMATCH`). The memo is computed from `result.record`, never taken
   * from `result.memo`. The release then runs and is recorded as
   * {@link Escro.releasePaymentWithOutcome} does.
   *
   * @returns `{ signature, confirm, memo }`.
   */
  async releaseWithPredicate(
    address: string,
    result: PredicateResult,
  ): Promise<ReleaseWithPredicateOutcome> {
    assertPublicKey("address", address);
    const { record } = result;
    if (record.decision !== "pass") {
      throw new EscroError(
        `The predicate decided ${record.decision} for escrow ${address}; nothing is released`,
        "PREDICATE_NOT_PASSED",
      );
    }
    const memo = predicateMemo(record);
    this.assertOwnJob(address, record.job);
    await this.assertCommitted(address, record.deliverableHash);
    return { ...(await this.release(address, memo)), memo };
  }

  // A record decides one job: a record for another network, program or escrow is a replay.
  private assertOwnJob(address: string, job: DecisionJob): void {
    const refuse = (member: string, own: string, named: string, code: string): void => {
      if (named !== own) {
        throw new EscroError(
          `The record's job.${member} ${named} is not ${own}, the ${member} of escrow ${address} on this client; nothing is released`,
          code,
        );
      }
    };
    refuse("network", getCaip2Network(this.cluster), job.network, "PREDICATE_NETWORK_MISMATCH");
    refuse(
      "program",
      resolveProgramId(this.cluster).toBase58(),
      job.program,
      "PREDICATE_PROGRAM_MISMATCH",
    );
    refuse("id", address, job.id, "PREDICATE_JOB_MISMATCH");
  }

  // The escrow's own account, read from chain: SUBMITTED, and committing exactly `deliverableHash`.
  private async assertCommitted(address: string, deliverableHash: string): Promise<void> {
    const mismatch = (why: string, cause?: unknown): never => {
      throw new EscroError(
        `Escrow ${address} ${why}; the predicate's record is not over its committed deliverable`,
        "PREDICATE_DELIVERABLE_MISMATCH",
        undefined,
        cause === undefined ? undefined : { cause },
      );
    };
    const info = await this.connection.getAccountInfo(new PublicKey(address), "confirmed");
    if (info === null) return mismatch("has no account on chain");
    if (!info.owner.equals(resolveProgramId(this.cluster))) {
      return mismatch("is not owned by the Escro program");
    }
    let account: ReturnType<typeof decodeEscrowAccount>;
    try {
      account = decodeEscrowAccount(info.data);
    } catch (err) {
      if (!(err instanceof ChainReadError)) throw err;
      return mismatch("is not a current EscrowAccount", err);
    }
    if (account.state !== "Submitted") {
      return mismatch(`is ${String(account.state)} on chain, not Submitted`);
    }
    if (account.deliverable_hash !== deliverableHash) {
      return mismatch(`commits ${String(account.deliverable_hash)}, not ${deliverableHash}`);
    }
  }

  // The one release body: the plain release and the predicate release differ only by the memo.
  private async release(address: string, memo?: string): Promise<ReleasePaymentOutcome> {
    const signature = await this.sendRelease(address, true, memo);

    // Record it AFTER the chain settled: /release records COMPLETED only once the API's RPC
    // shows the account closed, and refuses with ESCROW_NOT_SETTLED until then. A failure
    // past the retry window is reported, never thrown: the on-chain signature is authoritative.
    try {
      await this.retryRecord(
        address,
        signature,
        () => this.api.releasePaymentDb(address),
        isRetryableReleaseCode,
      );
    } catch (err) {
      if (!(err instanceof EscroConfirmError)) throw err;
      return { signature, confirm: { landed: false, error: err } };
    }

    return { signature, confirm: { landed: true } };
  }

  // Builds, signs and sends the buyer's release_payment, with the memo when given; with `wait`,
  // returns once it confirmed.
  private async sendRelease(address: string, wait: boolean, memo?: string): Promise<string> {
    // Fetch escrow metadata for worker pubkey + mint
    const escrow = await this.api.getEscrow(address);
    if (!escrow.taker) {
      throw new EscrowNotFoundError(`Escrow ${address} has no assigned worker`);
    }

    // Fetch platform config for treasury pubkey + usdc mint
    const { treasury, mint } = await fetchPlatformConfig(this.connection, this.cluster);

    // Build, sign, and submit the on-chain release_payment FIRST. The API's COMPLETED
    // record must NOT precede settlement: a failed on-chain tx would otherwise leave
    // the escrow COMPLETED in the API's record but funded on-chain, and the oracle
    // would no longer time it out. The chain is the source of truth.
    const unsignedTx = await buildReleasePaymentTx({
      buyer: this.options.wallet.publicKey,
      escrowPda: new PublicKey(address),
      worker: new PublicKey(escrow.taker),
      mint,
      treasury,
      connection: this.connection,
      cluster: this.cluster,
      ...(memo === undefined ? {} : { memo }),
    });
    return this.send(
      unsignedTx,
      {
        name: "release_payment",
        escrowPda: address,
        worker: escrow.taker,
        treasury: treasury.toBase58(),
        mint: mint.toBase58(),
        ...(memo === undefined ? {} : { memo }),
      },
      undefined,
      wait,
    );
  }

  /**
   * Raise a dispute for an escrow. Either the buyer or the assigned worker
   * may call this. Signs and submits the `raise_dispute` on-chain tx, then confirms it with the API.
   * With `{ wait: false }` it returns once the dispute is sent; `evidence` then is refused
   * (`VALIDATION_ERROR`) before any request: attach it later with
   * `confirm(address, signature, { evidence })`. See {@link SendOptions.wait}.
   *
   * @returns Solana transaction signature.
   */
  async raiseDispute(
    address: string,
    params: RaiseDisputeParams,
    options?: SendOptions,
  ): Promise<string> {
    const wait = options?.wait ?? true;
    const reasonError = disputeReasonError(params.reason);
    if (reasonError !== null) throw new EscroError(reasonError, "VALIDATION_ERROR");
    // Checked before anything lands: confirm validates evidence only after the
    // dispute is on chain, where a rejection would leave it unrecorded.
    if (params.evidence !== undefined && !isSafeUrl(params.evidence)) {
      throw new EscroError(
        `evidence must be an http(s), ipfs or ar URL: ${params.evidence}`,
        "VALIDATION_ERROR",
      );
    }
    // Evidence reaches the arbitrator only through the disputant's confirm, which an async
    // dispute never sends.
    if (!wait && params.evidence !== undefined) {
      throw new EscroError(
        "evidence travels only with the dispute's confirm: raise the dispute with { wait: false } and no evidence, then attach it with confirm(address, signature, { evidence })",
        "VALIDATION_ERROR",
      );
    }
    const { unsignedTx } = await this.api.raiseDispute(address, { reason: params.reason });
    const signature = await this.send(
      unsignedTx,
      {
        name: "raise_dispute",
        escrowPda: address,
        reason: params.reason,
      },
      undefined,
      wait,
    );
    if (!wait) return signature;
    await this.confirm(address, signature, {
      ...(params.evidence !== undefined && { evidence: params.evidence }),
    });
    return signature;
  }

  /**
   * Cancel a funded escrow before any worker has claimed it.
   * Buyer must be the wallet in the constructor. Only valid when state is `FUNDED`.
   * Signs and submits the `cancel_escrow` on-chain tx, then confirms it with the API; full USDC refund to buyer.
   * With `{ wait: false }` it returns once the cancel is sent; see {@link SendOptions.wait}.
   *
   * @returns Solana transaction signature.
   */
  async cancelEscrow(address: string, options?: SendOptions): Promise<string> {
    const { unsignedTx } = await this.api.cancelEscrow(address);
    return this.sendAndConfirm(
      address,
      unsignedTx,
      { name: "cancel_escrow", escrowPda: address },
      options,
    );
  }

  /**
   * Pays an x402 V2 402: `params.url`, which the SDK requests for its 402, or
   * `params.paymentRequired`, a 402 the caller already decoded. Only an entry paying exactly
   * `params.amountMicroUsdc` to `params.to` on this client's cluster is paid; `params.policy` can
   * only narrow the choice. An `on-delivery` (or `job-escrow`) entry is funded through
   * {@link createEscrow}, with `to` as the assigned worker and its spend cap unchanged, and the
   * payment is presented once to the URL that answered the 402 (no redirect followed, nothing
   * retried); the result carries the `create_escrow` signature as `reference`, the escrow PDA, and
   * the paid request's decoded `PAYMENT-RESPONSE` and response.
   *
   * Without a `policy` the escrow rail wins: when an `on-delivery` or `job-escrow` entry matches
   * the caller's terms it is the one paid, whatever the 402's order. An `exact` entry is paid over
   * the x402 rail, from this wallet, under {@link EscroOptions.x402SpendCap} (required on mainnet):
   * the official client builds the transaction, a guarded signer checks it against the entry and
   * the caller's terms before the key runs, and the payment header goes once to the 402's resource
   * URL, never to a facilitator. The result's `reference` is the settlement's transaction. An `upto`
   * entry is never paid ({@link EscroPayError} `unsupported_scheme`). A failure after the payment
   * left the process (`settlement`, `presentation`, `redirect`, `timeout`) carries `payment`, the
   * Memo text, amount and `payTo`, to match against the wallet's token-account history; the amount
   * stays counted. x402 V2 has no idempotency key: two calls are two payments, each counted.
   *
   * The first request is bounded by 30 s, the paid request by the entry's `maxTimeoutSeconds`; an
   * entry over 3600 seconds is not paid. A network failure of the first request rejects
   * {@link EscroError} `NETWORK_ERROR`, with nothing funded. Refusals are {@link EscroPayError}s; a
   * failure after the escrow is funded carries `escrowPda` and `createSignature`, and
   * `cancelEscrow(escrowPda)` recovers the deposit while it is Funded. There is no idempotency key:
   * two calls fund two escrows. The signature is FROZEN.
   */
  pay(params: PayParams): Promise<PaymentResult> {
    return payOver402(
      {
        escro: this,
        wallet: this.options.wallet,
        cluster: this.cluster,
        rpc: this.connection,
        router: this.router,
        rpcUrl: this.options.rpcUrl,
        x402SpendCap: this.x402SpendCap,
      },
      params,
    );
  }

  /**
   * Claim an assigned task. Worker must be the wallet in the constructor.
   * Signs and submits the `claim_task` on-chain tx, then confirms it with the API.
   * With `{ wait: false }` it returns once the claim is sent; see {@link SendOptions.wait}.
   *
   * @returns Solana transaction signature.
   */
  async claimTask(address: string, options?: SendOptions): Promise<string> {
    const { unsignedTx } = await this.api.claimTask(address);
    return this.sendAndConfirm(
      address,
      unsignedTx,
      { name: "claim_task", escrowPda: address },
      options,
    );
  }

  /**
   * Submit a deliverable for the buyer to review. Worker must be the wallet.
   * Signs and submits the `submit_deliverable` on-chain tx, then confirms it with the API.
   * With `{ wait: false }` it returns once the submit is sent; see {@link SendOptions.wait}.
   *
   * @returns Solana transaction signature.
   */
  async submitDeliverable(
    address: string,
    params: SubmitDeliverableParams,
    options?: SendOptions,
  ): Promise<string> {
    const { unsignedTx } = await this.api.submitDeliverable(address, params);
    return this.sendAndConfirm(
      address,
      unsignedTx,
      {
        name: "submit_deliverable",
        escrowPda: address,
        deliverableHash: params.contentHash,
        proofUri: params.proofUri ?? null,
      },
      options,
    );
  }

  /**
   * List tasks assigned to the wallet's public key.
   * Optionally filter by state(s) and paginate results.
   *
   * If `options.poll` is true, polls with exponential backoff until at least
   * one task is returned.
   *
   * Serves open tasks only (FUNDED, IN_PROGRESS, SUBMITTED); a DISPUTED or settled
   * escrow assigned to the wallet comes from {@link getMyAssignedEscrows}.
   *
   * @param state   - Filter by one or more states (first state used as API filter).
   * @param options - Polling, pagination (limit/offset).
   */
  async getMyTasks(
    state?: EscrowState[],
    options?: PollOptions & ListOptions,
  ): Promise<PaginatedResult<EscrowAccount>> {
    const assignedTo = this.options.wallet.publicKey.toBase58();
    const params: Parameters<ApiClient["listEscrows"]>[0] = {
      assignedTo,
      ...(state?.[0] != null && { state: state[0] }),
      ...(options?.limit != null && { limit: options.limit }),
      ...(options?.offset != null && { offset: options.offset }),
    };

    if (!options?.poll) {
      return this.api.listEscrows(params);
    }

    const fetcher = () =>
      this.api.listEscrows(params).then((result) => (result.items.length > 0 ? result : null));

    return pollUntil(
      assignedTo,
      fetcher,
      (r): r is PaginatedResult<EscrowAccount> => r !== null,
      options.timeoutMs,
    );
  }

  /**
   * List every escrow assigned to the wallet's public key in any served state,
   * DISPUTED and the settled states (COMPLETED, REFUNDED) included, unlike
   * {@link getMyTasks}, which serves open tasks only. Optionally filter by state
   * and paginate. Never polls.
   *
   * A Worker Bot uses this to read its DISPUTED escrows, whose fronted cost stays
   * committed until arbitration settles them.
   *
   * @param state   - Filter by one or more states (first state used as API filter).
   * @param options - Pagination (limit/offset).
   */
  async getMyAssignedEscrows(
    state?: EscrowState[],
    options?: ListOptions,
  ): Promise<PaginatedResult<EscrowAccount>> {
    return this.api.listEscrows({
      taker: this.options.wallet.publicKey.toBase58(),
      ...(state?.[0] != null && { state: state[0] }),
      ...(options?.limit != null && { limit: options.limit }),
      ...(options?.offset != null && { offset: options.offset }),
    });
  }

  /**
   * List escrows CREATED by the wallet's public key (the maker / buyer), the
   * mirror of {@link getMyTasks} for the buyer side. Optionally filter by state
   * and paginate.
   *
   * A Buyer Bot uses this to sum its own outstanding (still-locked) escrows for
   * the client-side spend cap: the program is the source of truth, so the total
   * is read from chain state (via the API), never a local tally a crash could lose.
   *
   * @param state   - Filter by one or more states (first state used as API filter).
   * @param options - Polling, pagination (limit/offset).
   */
  async getMyEscrows(
    state?: EscrowState[],
    options?: PollOptions & ListOptions,
  ): Promise<PaginatedResult<EscrowAccount>> {
    const maker = this.options.wallet.publicKey.toBase58();
    const params: Parameters<ApiClient["listEscrows"]>[0] = {
      maker,
      ...(state?.[0] != null && { state: state[0] }),
      ...(options?.limit != null && { limit: options.limit }),
      ...(options?.offset != null && { offset: options.offset }),
    };

    if (!options?.poll) {
      return this.api.listEscrows(params);
    }

    const fetcher = () =>
      this.api.listEscrows(params).then((result) => (result.items.length > 0 ? result : null));

    return pollUntil(
      maker,
      fetcher,
      (r): r is PaginatedResult<EscrowAccount> => r !== null,
      options.timeoutMs,
    );
  }

  /**
   * Find worker bots in the EscroBots registry, optionally filtered by
   * capability. Queries `GET /v1/bots?role=worker` (the API includes `both`
   * bots) and returns candidates in REGISTRY ORDER: this method does no
   * ranking, scoring, or reordering: the directory is an open index with no
   * curation, not a marketplace. Escro-shipped code never ranks; the caller's own bot decides.
   *
   * Each candidate keeps the CLAIM (`descriptor`) separate from the AUTHORSHIP
   * check (`signatureValid`, verified locally so a third party need not trust the
   * API). Capabilities remain unverified claims; on-chain history (EscroRep)
   * is their verification, deliberately not merged in here.
   */
  async findWorkers(
    params: { capability?: string } & ListOptions = {},
  ): Promise<WorkerCandidate[]> {
    const { items } = await this.api.listBots({
      role: "worker",
      ...(params.capability != null && { capability: params.capability }),
      ...(params.limit != null && { limit: params.limit }),
      ...(params.offset != null && { offset: params.offset }),
    });
    return items.map((descriptor) => ({
      descriptor,
      signatureValid: verifyBotDescriptorSignature(descriptor),
    }));
  }

  /**
   * Fetch the EscroRep bulk export: every indexed wallet's RAW reputation
   * components, each wallet exactly once, in one fetch. Returns
   * the raw components verbatim - this method does NO ranking, scoring, or default
   * weighting (Escro-shipped code never ranks; the caller's own bot weights and
   * decides). Selection layers join these components to {@link findWorkers}
   * candidates by wallet. Throws {@link ReputationUnavailableError} when the
   * deployment mounts no reputation source (HTTP 404).
   */
  async listReputations(): Promise<ServedWalletReputation[]> {
    return this.api.listReputations();
  }

  /**
   * Fetch protocol-wide stats from the public `GET /v1/stats` endpoint.
   *
   * @returns protocol-wide {@link ProtocolStats}.
   */
  async getStats(): Promise<ProtocolStats> {
    const data = await this.api.getStats();
    return data as ProtocolStats;
  }

  /**
   * Ask the API to record the create, claim, submit, cancel or dispute that the
   * landed `signature` carries; the API verifies it on chain first. Retries a
   * not-yet-visible transaction, an RPC failure, a gateway error or a rate limit
   * for about 30 s (waiting at least a sent Retry-After), never a rejection. Throws
   * {@link EscroConfirmError}; calling again is safe (a replay of a recorded
   * transition succeeds). An `address` that is not a base-58 public key throws an
   * {@link EscroError} with code `VALIDATION_ERROR` before any request, not an
   * `EscroConfirmError`. A successful confirm of a create, or a confirm of its signature
   * refused `TX_FAILED` (the create landed and failed), ends its in-flight hold under
   * {@link EscroOptions.spendCap}.
   */
  async confirm(
    address: string,
    signature: string,
    opts: { evidence?: string } = {},
  ): Promise<EscrowAccount> {
    assertPublicKey("address", address);
    const wallet = this.options.wallet.publicKey.toBase58();
    let escrow: EscrowAccount;
    try {
      escrow = await this.retryRecord(
        address,
        signature,
        () => this.api.confirm(address, signature, opts.evidence),
        isRetryableConfirmCode,
      );
    } catch (err) {
      // The create's own transaction failed at execution, so it moved no deposit.
      if (err instanceof EscroConfirmError && err.code === "TX_FAILED") {
        dropFailed(this.cluster, wallet, address, signature);
      }
      throw err;
    }
    // The API now counts the escrow, so the spend cap stops holding it as in flight.
    dropPending(this.cluster, wallet, address);
    return escrow;
  }

  // Calls `record` until the API records the landed `signature`: a code `retryable` accepts or
  // a network failure is retried for about 30 s (waiting at least a sent Retry-After), any
  // other refusal is not. Throws EscroConfirmError.
  private async retryRecord<T>(
    address: string,
    signature: string,
    record: () => Promise<T>,
    retryable: (code: string) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + CONFIRM_WINDOW_MS;
    let delay = CONFIRM_FIRST_DELAY_MS;
    for (;;) {
      let code: string;
      let message: string;
      let retryAfterMs: number | undefined;
      let wait = delay;
      try {
        return await record();
      } catch (err) {
        if (err instanceof EscroError) {
          if (!retryable(err.code)) {
            throw new EscroConfirmError(
              address,
              signature,
              err.code,
              err.message,
              err.retryAfterMs,
            );
          }
          code = err.code;
          message = err.message;
          retryAfterMs = err.retryAfterMs;
          wait = Math.max(delay, err.retryAfterMs ?? 0);
        } else {
          // A network failure: the request may not have reached the API.
          code = "NETWORK_ERROR";
          message = err instanceof Error ? err.message : String(err);
        }
      }
      if (Date.now() + wait > deadline) {
        throw new EscroConfirmError(address, signature, code, message, retryAfterMs);
      }
      await sleep(wait);
      delay = Math.min(delay * 2, CONFIRM_MAX_DELAY_MS);
    }
  }

  // Prices the deposit, checks the cap and POSTs inside the wallet's admission, then holds the
  // deposit as in flight: the API counts no CREATED escrow, so without the hold a concurrent
  // create of the same wallet would read a total that misses this one. The fee is read inside so
  // a create is priced at the fee in force after every create admitted before it.
  private async admitCreate(
    cap: Readonly<SpendCap>,
    wallet: string,
    params: CreateEscrowParams,
  ): Promise<{ escrowId: string; escrowPda: string; unsignedTx: string }> {
    const ledger = walletLedger(this.cluster, wallet);
    return admit(ledger, async () => {
      const { feeBps } = await boundedRead("The PlatformConfig read", () =>
        fetchPlatformConfig(this.connection, this.cluster),
      );
      const amount = BigInt(params.amountUsdc);
      const deposit = amount + escrowFee(amount, feeBps);
      await this.dropServed(ledger);
      // Taken before the read: a create confirmed during the read leaves the in-flight set and
      // may be missing from the read, and the reverse order would count it nowhere.
      const inFlight = pendingMicroUsdc(ledger);
      const read = await this.readOutstanding(cap, wallet);
      // A total past 2^53 rounds as a number but stays above every cap, a safe integer.
      assertWithinSpendCap({
        maxOutstandingMicroUsdc: cap.maxOutstandingMicroUsdc,
        outstandingMicroUsdc: Number(inFlight + BigInt(read)),
        proposedMicroUsdc: Number(deposit),
      });
      const created = await this.api.createEscrow(params);
      // A new create's escrow is never one already in flight: a repeated answer would replace
      // that create's hold, and a failed send of this one would drop it.
      if (ledger.pending.has(created.escrowPda)) {
        throw new EscroError(
          `The API answered a create with escrow ${created.escrowPda}, which this wallet already has in flight`,
          "UNEXPECTED_TRANSACTION",
        );
      }
      ledger.pending.set(created.escrowPda, { deposit });
      return created;
    });
  }

  // Ends the hold of each in-flight create the API now serves (an unconfirmed create is never
  // served, so a served escrow landed and its deposit is in the API's own count while open). A
  // read that fails keeps the hold: it only overcounts.
  private async dropServed(ledger: WalletLedger): Promise<void> {
    await Promise.all(
      [...ledger.pending.keys()].map(async (address) => {
        try {
          await boundedRead("The escrow read", () => this.api.getEscrow(address));
        } catch {
          return;
        }
        ledger.pending.delete(address);
      }),
    );
  }

  // The deposits the API counts for the wallet, or the injected `outstanding()`. Any failure is
  // `SPEND_CAP_UNREADABLE`: an unread total is never taken as zero.
  private async readOutstanding(cap: Readonly<SpendCap>, wallet: string): Promise<number> {
    let value: number;
    try {
      value =
        cap.outstanding === undefined
          ? outstandingFromAnswer(await this.api.getOutstandingDeposits(wallet), wallet)
          : await boundedRead("spendCap.outstanding()", cap.outstanding);
    } catch (err) {
      if (err instanceof EscroError && err.code === SPEND_CAP_ERROR_CODES.unreadable) throw err;
      throw new EscroError(
        `The outstanding deposits could not be read: ${err instanceof Error ? err.message : String(err)}`,
        SPEND_CAP_ERROR_CODES.unreadable,
        undefined,
        { cause: err },
      );
    }
    if (!isMicroUsdc(value)) {
      throw new EscroError(
        `The outstanding deposits read as ${String(value)}, not a whole micro-USDC amount a number holds exactly`,
        SPEND_CAP_ERROR_CODES.unreadable,
      );
    }
    return value;
  }

  private send(
    unsignedTx: string,
    expected: ExpectedTransaction,
    onSend?: () => void,
    wait = true,
  ): Promise<string> {
    return signAndSend(
      unsignedTx,
      this.options.wallet,
      this.connection,
      this.cluster,
      expected,
      onSend,
      wait,
    );
  }

  private async sendAndConfirm(
    address: string,
    unsignedTx: string,
    expected: ExpectedTransaction,
    options?: SendOptions,
  ): Promise<string> {
    const wait = options?.wait ?? true;
    const signature = await this.send(unsignedTx, expected, undefined, wait);
    if (wait) await this.confirm(address, signature);
    return signature;
  }

  /**
   * Fetch an escrow by its PDA address.
   * If `options.poll` is true, polls with exponential backoff until the escrow
   * appears (useful immediately after a create tx before the API records it).
   * An `address` that is not a base-58 public key throws an {@link EscroError} with code
   * `VALIDATION_ERROR` at once, with or without `poll`.
   */
  async getEscrow(address: string, options?: PollOptions): Promise<EscrowAccount> {
    if (!options?.poll) {
      return this.api.getEscrow(address);
    }

    return pollUntil(
      address,
      () =>
        this.api.getEscrow(address).catch((e: unknown) => {
          if (e instanceof EscrowNotFoundError) return null;
          throw e instanceof Error ? e : new Error(String(e));
        }),
      (r): r is EscrowAccount => r !== null,
      options.timeoutMs,
    );
  }
}
