// BuyerBot loop.
//
//   pick a worker (config-pinned wallet) -> create_escrow -> fund -> poll ->
//   on SUBMITTED run review -> release_payment (accept, with the decision memo when
//   the review carries a predicate) or raise_dispute (reject);
//   a release or dispute whose API confirm did not land is logged, never retried
//   here; a review, release or dispute that throws fails that escrow alone and the
//   pass goes on to the next escrow;
//   a FUNDED escrow past its deadline (never claimed) -> cancel_escrow
//
// Design notes that keep a real bot honest:
//   - The buyer's code is the JUDGE. Escro only enforces the state machine; the
//     accept/reject decision lives entirely in src/review.ts. Nothing here scores
//     a deliverable's quality.
//   - The CHAIN is the source of truth. The settle pass re-derives SUBMITTED
//     escrows from chain each pass, so it is idempotent: once released, an escrow
//     is no longer SUBMITTED and is not touched again.
//   - The spend cap is the SDK's, run inside `createEscrow` on every create: it
//     counts amount plus fee against the API's total of this wallet's open escrows
//     plus the process's in-flight creates, and fails CLOSED when that total
//     cannot be read.

import { EscroConfirmError, EscrowState, parseUsdc } from "@escro/sdk";
import type {
  CreateEscrowParams,
  CreateEscrowResult,
  EscrowAccount,
  PredicateResult,
  ReleasePaymentOutcome,
  ReleaseWithPredicateOutcome,
} from "@escro/sdk";
import type { Deliverable, KitReviewPolicy, PredicateReviewResult } from "./review.js";
import type { Telemetry } from "./telemetry.js";

/** The subset of the Escro SDK client the buyer loop uses (a real `Escro` satisfies it). */
export interface BuyerClient {
  getMyEscrows(
    state?: EscrowState[],
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: EscrowAccount[]; total: number }>;
  createEscrow(params: CreateEscrowParams): Promise<CreateEscrowResult>;
  releasePaymentWithOutcome(address: string): Promise<ReleasePaymentOutcome>;
  releaseWithPredicate(
    address: string,
    result: PredicateResult,
  ): Promise<ReleaseWithPredicateOutcome>;
  raiseDispute(address: string, params: { reason: string; evidence?: string }): Promise<string>;
  cancelEscrow(address: string): Promise<string>;
}

// The program caps raise_dispute's reason at 200 UTF-8 bytes (MAX_DISPUTE_REASON_BYTES in
// @escro/shared); the SDK refuses a longer reason before anything is sent.
const MAX_DISPUTE_REASON_BYTES = 200;

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8, cut between code points. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let out = "";
  for (const char of text) {
    bytes += encoder.encode(char).length;
    if (bytes > maxBytes) break;
    out += char;
  }
  return out;
}

export interface BuyerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// The API caps a page at 100 (default 20). Pagination walks to exhaustion, so a
// pass never misses an escrow past the first page.
const PAGE_LIMIT = 100;

/**
 * Fetch every escrow this buyer created in `state`, paginating to exhaustion:
 * walk offsets until the collected count reaches the reported `total`. Read
 * failures propagate so callers fail CLOSED.
 */
async function fetchAllByState(client: BuyerClient, state: EscrowState): Promise<EscrowAccount[]> {
  const all: EscrowAccount[] = [];
  let offset = 0;
  for (;;) {
    const page = await client.getMyEscrows([state], { limit: PAGE_LIMIT, offset });
    all.push(...page.items);
    if (page.items.length === 0 || all.length >= page.total) break;
    offset += page.items.length;
  }
  return all;
}

export interface BuyerJob {
  /** Base-58 wallet of the worker to hire (config-pinned; `findWorkers` picks one from EscroBots). */
  assignedWorker: string;
  /** Worker's NET pay in USDC (>= $5 minimum, enforced on-chain). */
  amountUsdc: number;
  /** Full task specification. */
  taskSpec: CreateEscrowParams["taskSpec"];
  /** Unix timestamp (seconds) at which the escrow deadline expires. */
  deadlineUnix: number;
}

/**
 * Create + fund one escrow for `job`. A client built with a `spendCap` refuses,
 * creating nothing, a job whose amount plus fee would pass it or whose open total
 * cannot be read. An amount with more than six decimals is refused, never rounded.
 */
export async function createEscrowForJob(
  client: BuyerClient,
  job: BuyerJob,
  opts: { logger?: BuyerLogger; telemetry?: Telemetry } = {},
): Promise<CreateEscrowResult> {
  const log = opts.logger ?? console;
  const result = await client.createEscrow({
    taskSpec: job.taskSpec,
    amountUsdc: parseUsdc(String(job.amountUsdc)),
    deadlineUnix: job.deadlineUnix,
    assignedWorker: job.assignedWorker,
  });
  log.info(`[buyer] Created escrow ${result.escrowPda} for ${job.assignedWorker}.`);
  opts.telemetry?.stage("escrow_created");
  return result;
}

/**
 * Resolve a worker and, if one is found, hire it: stamp `worker_hired` and create
 * the escrow. Returns null in review-only mode (no worker pinned or discovered),
 * where the funnel does not advance past `started`. `resolveWorker` is injected so
 * this stays testable without an RPC (bot.ts wires the real EscroBots resolver).
 */
export async function runBuyerCreatePass(
  client: BuyerClient,
  resolveWorker: () => Promise<string>,
  buildJob: (assignedWorker: string) => BuyerJob,
  opts: { logger?: BuyerLogger; telemetry?: Telemetry } = {},
): Promise<CreateEscrowResult | null> {
  const log = opts.logger ?? console;
  const worker = await resolveWorker();
  if (worker === "") {
    log.info("[buyer] No worker pinned or discovered: review-only mode, raising no new jobs.");
    return null;
  }
  opts.telemetry?.stage("worker_hired");
  return createEscrowForJob(client, buildJob(worker), {
    ...(opts.telemetry !== undefined && { telemetry: opts.telemetry }),
    ...(opts.logger !== undefined && { logger: opts.logger }),
  });
}

/** What one settle pass did with one SUBMITTED escrow. */
export interface BuyerPassAction {
  address: string;
  action: "released" | "disputed" | "held" | "skipped" | "failed";
  signature?: string;
  memo?: string;
}

/** ` (<code>)` for an error carrying a string `code` (an EscroError), else "". */
function errorCodeOf(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) return "";
  return typeof err.code === "string" ? ` (${err.code})` : "";
}

/**
 * ` (signature "<sig>")` for an error carrying a string `signature` (a transaction that was
 * sent, so the operator can look it up on chain), else "". Quoted: a policy's error is free text.
 */
function signatureOf(err: unknown): string {
  if (typeof err !== "object" || err === null || !("signature" in err)) return "";
  return typeof err.signature === "string" ? ` (signature ${JSON.stringify(err.signature)})` : "";
}

// String() throws on a value with no primitive conversion (Object.create(null)); the pass
// must still log the escrow and go on.
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "(unprintable error)";
  }
}

/**
 * One settle pass: for every SUBMITTED escrow this buyer created, run `review`
 * and either release payment (accept) or raise a dispute (reject with dispute),
 * or hold (reject without dispute). Chain-derived and safe to call in a loop.
 * An accept carrying a predicate releases with its decision memo. A review, a
 * release or a dispute that throws fails that escrow alone, with no fallback
 * action for it, and the pass goes on; a failure to list SUBMITTED escrows, or a
 * throw from the telemetry sink, ends the pass.
 */
export async function runBuyerOnce(
  client: BuyerClient,
  review: KitReviewPolicy,
  opts: { logger?: BuyerLogger; telemetry?: Telemetry } = {},
): Promise<BuyerPassAction[]> {
  const log = opts.logger ?? console;
  const submitted = await fetchAllByState(client, EscrowState.SUBMITTED);
  const actions: BuyerPassAction[] = [];

  for (const escrow of submitted) {
    const { address } = escrow;
    if (escrow.deliverableHash === null) {
      log.warn(`[buyer] ${address} is SUBMITTED but carries no deliverable yet; skipping.`);
      actions.push({ address, action: "skipped" });
      continue;
    }
    const deliverable: Deliverable = {
      contentHash: escrow.deliverableHash,
      proofUri: escrow.proofUri,
    };
    let result: PredicateReviewResult;
    try {
      result = await review.evaluate(deliverable, {
        address,
        submittedAt: escrow.submittedAt,
      });
    } catch (err) {
      log.error(
        `[buyer] Could not review ${address}${errorCodeOf(err)}${signatureOf(err)}: ` +
          JSON.stringify(messageOf(err)),
      );
      actions.push({ address, action: "failed" });
      continue;
    }

    if (result.accept) {
      let outcome: ReleasePaymentOutcome & { memo?: string };
      try {
        outcome =
          result.predicate === undefined
            ? await client.releasePaymentWithOutcome(address)
            : await client.releaseWithPredicate(address, result.predicate);
      } catch (err) {
        log.error(`[buyer] Could not release ${address}${errorCodeOf(err)}: ${messageOf(err)}`);
        actions.push({ address, action: "failed" });
        continue;
      }
      const { signature, confirm, memo } = outcome;
      log.info(
        memo === undefined
          ? `[buyer] Released ${address}: ${result.reason}`
          : `[buyer] Released ${address} with memo ${memo}: ${result.reason}`,
      );
      if (!confirm.landed) {
        log.warn(
          `[buyer] The API did not record the release of ${address} ` +
            `(signature ${signature}, ${confirm.error.code}); the on-chain release stands.`,
        );
      }
      // Settled = the buyer released and the worker was paid: the TTFE terminal.
      // Dedup in the emitter records only the first settlement of this funnel.
      opts.telemetry?.stage("settled");
      actions.push({
        address,
        action: "released",
        signature,
        ...(memo !== undefined && { memo }),
      });
      continue;
    }
    if (result.dispute) {
      let signature: string;
      try {
        signature = await client.raiseDispute(address, {
          reason: truncateUtf8(result.reason, MAX_DISPUTE_REASON_BYTES),
        });
      } catch (err) {
        // The dispute landed and the API did not record it: the dispute stands on chain.
        if (err instanceof EscroConfirmError && err.code !== "TX_FAILED") {
          log.warn(`[buyer] Disputed ${address}: ${result.reason}`);
          log.warn(
            `[buyer] The API did not record the dispute of ${address} ` +
              `(signature ${err.signature}, ${err.code}); the on-chain dispute stands.`,
          );
          actions.push({ address, action: "disputed", signature: err.signature });
          continue;
        }
        log.error(
          `[buyer] Could not dispute ${address}${errorCodeOf(err)}${signatureOf(err)} ` +
            `(reason ${JSON.stringify(result.reason)}): ${JSON.stringify(messageOf(err))}`,
        );
        actions.push({ address, action: "failed" });
        continue;
      }
      log.warn(`[buyer] Disputed ${address}: ${result.reason}`);
      actions.push({ address, action: "disputed", signature });
      continue;
    }
    // hash-matches states the timeout, or when it will dispute, in its own hold reasons.
    const note =
      review.name === "hash-matches"
        ? ""
        : " Note: the 24h timeout will auto-release to the worker unless you configure a review predicate.";
    log.warn(`[buyer] Holding ${address} (no release, no dispute): ${result.reason}${note}`);
    actions.push({ address, action: "held" });
  }
  return actions;
}

// Escrows whose cancel has failed, with every reason already logged, so a cancel that keeps
// failing (the API still lists FUNDED while the chain shows it claimed) warns once per
// distinct reason, not every poll, and at most MAX_CANCEL_WARNINGS times: a reason carrying a
// per-attempt value (a signature, a blockhash) differs on every pass. An escrow no longer
// listed FUNDED is dropped each pass, so a later failure warns again.
const failedCancels = new Map<string, Set<string>>();
const MAX_CANCEL_WARNINGS = 3;

/**
 * One cancel pass: cancel every FUNDED escrow this buyer created whose deadline
 * has passed. No worker claimed it in time, so the buyer takes its USDC back
 * rather than waiting for the backend's deadline refund. A failed cancel (for
 * example, a worker claimed it meanwhile) is logged once per escrow and reason
 * (at most three times while it stays FUNDED), retried on the next pass, and the
 * pass moves on.
 */
export async function runBuyerCancelPass(
  client: BuyerClient,
  opts: { nowUnix?: number; logger?: BuyerLogger } = {},
): Promise<void> {
  const log = opts.logger ?? console;
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const funded = await fetchAllByState(client, EscrowState.FUNDED);
  const listed = new Set(funded.map((e) => e.address));
  for (const address of failedCancels.keys()) {
    if (!listed.has(address)) failedCancels.delete(address);
  }

  for (const escrow of funded) {
    if (escrow.deadline >= nowUnix) continue;
    try {
      await client.cancelEscrow(escrow.address);
      log.info(`[buyer] Cancelled ${escrow.address}: unclaimed past its deadline.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const logged = failedCancels.get(escrow.address) ?? new Set<string>();
      failedCancels.set(escrow.address, logged);
      if (logged.has(reason) || logged.size >= MAX_CANCEL_WARNINGS) continue;
      logged.add(reason);
      const last = logged.size === MAX_CANCEL_WARNINGS ? "; further reasons are not logged" : "";
      log.warn(
        `[buyer] Could not cancel ${escrow.address} (retried each pass, logged once per reason${last}): ${reason}`,
      );
    }
  }
}
