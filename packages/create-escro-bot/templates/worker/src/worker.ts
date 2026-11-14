// WorkerBot loop.
//
//   poll assigned escrows -> claim_task -> adapter.execute(spec)
//   (the adapter pins through the storage; else the worker uploads the content)
//   -> submit_deliverable -> await release
//
// Design notes that keep a real bot honest:
//   - The CHAIN is the source of truth. `runWorkerOnce` reads current on-chain
//     state each pass, so a crashed bot resumes correctly: a job already claimed
//     (IN_PROGRESS) is finished without re-claiming; a job already submitted
//     (SUBMITTED) or disputed (DISPUTED) is left to await release or arbitration,
//     its cost still counted against the float. Local memory holds only what the
//     402 menu shares with the loop: which escrows this process is working now,
//     and the spec a 402 job was bought on until its submit lands.
//   - Never claim what it can't finish (deadline guard) or can't fund (float
//     bound): both refuse BEFORE claim, so buyer funds are never stranded against
//     the 24h timeout backstop.
//   - The bot never judges deliverable quality: that is the buyer's job.

import {
  EscroConfirmError,
  EscrowState,
  EscrowStateError,
  EscrowTimeoutError,
  proofUriError,
} from "@escro/sdk";
import type { EscrowAccount, ServiceAdapter, ServiceResult, TaskSpec } from "@escro/sdk";
import { canFinishBeforeDeadline } from "./deadline.js";
import { assertWithinFloatBound, usdcToMicro } from "./float-cap.js";
import type { Storage } from "./storage.js";

/** The subset of the Escro SDK client the loop uses (a real `Escro` satisfies it). */
export interface WorkerClient {
  getMyTasks(
    state?: EscrowState[],
    options?: { poll?: boolean; timeoutMs?: number; limit?: number; offset?: number },
  ): Promise<{ items: EscrowAccount[]; total: number }>;
  getMyAssignedEscrows(
    state?: EscrowState[],
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: EscrowAccount[]; total: number }>;
  claimTask(address: string): Promise<string>;
  submitDeliverable(
    address: string,
    params: { contentHash: string; proofUri?: string },
  ): Promise<string>;
  /** Asks the API to record a landed transaction; the 402 menu calls it for a claim that threw and then landed. */
  confirm(address: string, signature: string): Promise<EscrowAccount>;
}

export interface WorkerLoopConfig {
  /** Working-capital bound in USDC: REQUIRED, never silently unbounded. */
  maxConcurrentFloatUsdc: number;
  /** Typical service cost this worker fronts per job, in USDC. */
  estimatedServiceCostUsdc: number;
  /** Typical time this worker takes per job, in seconds. */
  estimatedDurationSeconds: number;
  /** Margin required before a deadline before claiming, in seconds. */
  deadlineSafetyBufferSeconds: number;
}

export interface WorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface WorkerDeps {
  adapter: ServiceAdapter;
  storage: Storage;
  /** Resolve the full TaskSpec for a claimed escrow (from the buyer, checked against `taskSpecHash`). */
  resolveTaskSpec: (task: EscrowAccount) => Promise<TaskSpec>;
  /** Estimate this job's service cost (USDC). Defaults to the config constant. */
  estimateServiceCostUsdc?: (task: EscrowAccount) => number;
  /** A reason not to claim `task`, or null. Evaluated before every other claim guard. */
  claimRefusal?: (task: EscrowAccount) => Promise<string | null>;
  /** Runs a job in place of `adapter.execute(spec)`, for work that depends on the escrow. */
  executeJob?: ExecuteJob;
  /** Estimate this job's duration (seconds). Defaults to the config constant. */
  estimateDurationSeconds?: (task: EscrowAccount) => number;
  /** Current time (Unix seconds). Injectable for tests. */
  nowSeconds?: () => number;
  /** When set, wait up to this many ms for at least one assigned task to appear. */
  pollForTasksMs?: number;
  logger?: WorkerLogger;
  /**
   * Escrows being worked in this process. A pass skips any it holds, FUNDED or IN_PROGRESS, so
   * the 402 path and the loop never work one escrow twice.
   */
  executors?: Set<string>;
  /**
   * The spec each 402 job was bought on, by escrow, until its submit lands. A resume prefers it over
   * `resolveTaskSpec`; the resolver is reached after a restart, which forgets it, and for a job the
   * menu has not handed off: a claim that threw before the menu saw it land, or a hand-off skipped or
   * come late because the loop was already working the escrow.
   */
  menuSpecs?: Map<string, TaskSpec>;
  /** Set when the 402 menu is enabled: each pass publishes the float the menu's claims read. */
  committed?: CommittedSnapshot;
  /** Submits a deliverable. Defaults to the client's own; the menu's records it for the buyer's poll. */
  submit?: SubmitDeliverable;
}

export type ExecuteJob = (escrow: string, spec: TaskSpec) => Promise<ServiceResult>;

type SubmitDeliverable = (
  address: string,
  params: { contentHash: string; proofUri?: string },
) => Promise<string>;

/** The float the 402 path reads between passes: the last pass's committed jobs plus every claim since, each once. */
export interface CommittedSnapshot {
  /** False until a pass has read all four states: a claim before then is refused. */
  isPublished(): boolean;
  /**
   * The committed working capital, in integer micro-USDC; `except`'s own reservation left out, for a
   * claim of that escrow that will replace it.
   */
  inFlightMicroUsdc(except?: string): number;
  /** Counts a claim from before it is sent, so two claims in flight cannot both fit under the bound. */
  reserve(address: string, microUsdc: number): void;
  /** Takes back a reservation whose claim did not land. */
  release(address: string): void;
  /** The addresses reserved so far; a pass notes them before its first read. */
  reservations(): Set<string>;
  /**
   * Replaces the committed jobs with a pass's reads, each listed job's cost by address, and drops
   * the reservations those reads answered. A reservation also listed counts once.
   */
  publish(jobs: Map<string, number>, settled: Iterable<string>): void;
  /**
   * Holds `address`'s reservation until `untilMs` (Unix ms): its claim was sent and may still land, so
   * a pass that does not list it committed keeps it. Ends with the reservation; none without one.
   */
  hold(address: string, untilMs: number): void;
  /** Ends `address`'s hold; its reservation stays. */
  endHold(address: string): void;
  /** Each held reservation's end, Unix ms. */
  holds(): ReadonlyMap<string, number>;
}

export function createCommittedSnapshot(): CommittedSnapshot {
  let listed: Map<string, number> | undefined;
  const claims = new Map<string, number>();
  const held = new Map<string, number>();
  return {
    isPublished: () => listed !== undefined,
    inFlightMicroUsdc: (except) =>
      [
        ...new Map([
          ...(listed ?? []),
          ...[...claims].filter(([address]) => address !== except),
        ]).values(),
      ].reduce((sum, c) => sum + c, 0),
    reserve: (address, microUsdc) => {
      claims.set(address, microUsdc);
    },
    release: (address) => {
      claims.delete(address);
      held.delete(address);
    },
    reservations: () => new Set(claims.keys()),
    publish: (jobs, settled) => {
      listed = jobs;
      for (const address of settled) {
        claims.delete(address);
        held.delete(address);
      }
    },
    hold: (address, untilMs) => {
      if (claims.has(address)) held.set(address, untilMs);
    },
    endHold: (address) => {
      held.delete(address);
    },
    holds: () => new Map(held),
  };
}

// The API caps a page at 100 (default 20). Each state is walked to exhaustion:
// an in-flight job left off a page would fail OPEN on the float bound.
const PAGE_LIMIT = 100;

type ListRead = (
  state: EscrowState[],
  options: { limit: number; offset: number },
) => Promise<{ items: EscrowAccount[]; total: number }>;

/**
 * Fetch every escrow `read` serves in `state`, walking offsets until an empty page
 * or the collected count reaches the reported `total`. Never polled. Read failures
 * propagate so the pass fails CLOSED.
 */
async function fetchAllByState(read: ListRead, state: EscrowState): Promise<EscrowAccount[]> {
  const all: EscrowAccount[] = [];
  let offset = 0;
  for (;;) {
    const page = await read([state], { limit: PAGE_LIMIT, offset });
    all.push(...page.items);
    if (page.items.length === 0 || all.length >= page.total) break;
    offset += page.items.length;
  }
  return all;
}

/** What delivering a job needs, on either path. */
interface DeliveryDeps {
  adapter: ServiceAdapter;
  storage: Storage;
  submit: SubmitDeliverable;
  logger: WorkerLogger;
  executeJob?: ExecuteJob;
}

/** The one executor both paths share: runs the adapter on `spec`, then submits. */
export async function executeAndSubmit(
  deps: DeliveryDeps,
  address: string,
  spec: TaskSpec,
): Promise<void> {
  const result =
    deps.executeJob !== undefined
      ? await deps.executeJob(address, spec)
      : await deps.adapter.execute(spec);
  // An adapter that pinned (a proof bundle or its content) already uploaded once through the
  // content-addressed storage, so its URI is submitted as-is. An empty URI is never sent.
  let proofUri = result.proofUri ?? "";
  const fromAdapter = proofUri !== "";
  if (!fromAdapter) {
    proofUri = (
      await deps.storage.upload({ content: result.content, contentHash: result.contentHash })
    ).proofUri;
  }
  // The API refuses an unfit URI at the submit build; stopping here keeps the reason local.
  // No content upload replaces an adapter's own URI: for a proof adapter the content alone
  // would make the buyer's proof policy dispute.
  const unfit = proofUriError(proofUri);
  if (unfit !== null) {
    throw new Error(
      `${address}: the proofUri ${fromAdapter ? "returned by" : "the storage returned for the content of"} adapter ${deps.adapter.id} cannot be submitted: ${unfit}`,
    );
  }
  await deps.submit(address, { contentHash: result.contentHash, proofUri });
  deps.logger.info(`[worker] Submitted deliverable for ${address}.`);
}

/**
 * Run one pass of the worker loop: resume any in-flight jobs, then claim and
 * execute the eligible FUNDED jobs assigned to this wallet. Safe to call in a
 * loop: it re-derives everything from on-chain state each time.
 */
export async function runWorkerOnce(
  client: WorkerClient,
  config: WorkerLoopConfig,
  deps: WorkerDeps,
): Promise<void> {
  const log = deps.logger ?? console;
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const costUsdc = deps.estimateServiceCostUsdc ?? (() => config.estimatedServiceCostUsdc);
  const durationSeconds = deps.estimateDurationSeconds ?? (() => config.estimatedDurationSeconds);
  const executors = deps.executors ?? new Set<string>();
  const snapshot = deps.committed ?? createCommittedSnapshot();
  const delivery: DeliveryDeps = {
    adapter: deps.adapter,
    storage: deps.storage,
    submit: deps.submit ?? ((address, params) => client.submitDeliverable(address, params)),
    logger: log,
    ...(deps.executeJob !== undefined && { executeJob: deps.executeJob }),
  };

  // One polled, unfiltered read gates the pass: a per-state poll would time out on
  // whichever state happens to be empty.
  if (deps.pollForTasksMs !== undefined) {
    try {
      await client.getMyTasks(undefined, { poll: true, timeoutMs: deps.pollForTasksMs });
    } catch (err) {
      if (err instanceof EscrowTimeoutError) {
        log.info("[worker] No assigned tasks appeared. Nothing to do.");
        return;
      }
      throw err;
    }
  }

  // getMyTasks serves open tasks only; a DISPUTED escrow is served only by the taker read.
  const openTasks: ListRead = (state, options) => client.getMyTasks(state, options);
  const assigned: ListRead = (state, options) => client.getMyAssignedEscrows(state, options);

  // Taken before the reads: a job released while they run is still listed as it was when held.
  const heldBeforeReads = new Set(executors);
  const reservedBeforeReads = snapshot.reservations();

  const resumable = await fetchAllByState(openTasks, EscrowState.IN_PROGRESS);
  const claimable = await fetchAllByState(openTasks, EscrowState.FUNDED);
  // The float decides a claim, so without the 402 menu SUBMITTED and DISPUTED are read only when
  // there is something to claim, keeping an idle pass at two list reads; the menu can claim at any
  // moment, so its snapshot is always complete. They are read after IN_PROGRESS in transition
  // order (DISPUTED last, after both states that lead to it) so a job moving forward between the
  // reads is seen twice, never missed.
  const readFloat = claimable.length > 0 || deps.committed !== undefined;
  const awaitingRelease = readFloat ? await fetchAllByState(openTasks, EscrowState.SUBMITTED) : [];
  const awaitingArbitration = readFloat
    ? await fetchAllByState(assigned, EscrowState.DISPUTED)
    : [];

  async function deliver(task: EscrowAccount): Promise<void> {
    const spec = deps.menuSpecs?.get(task.address) ?? (await deps.resolveTaskSpec(task));
    await executeAndSubmit(delivery, task.address, spec);
    deps.menuSpecs?.delete(task.address);
  }

  // Committed working capital = every job whose cost is fronted and not yet paid: claimed
  // (IN_PROGRESS), delivered and awaiting the buyer (SUBMITTED), or disputed and awaiting
  // arbitration (DISPUTED), each counted once by address. Only IN_PROGRESS is resumed.
  const committed = new Map<string, number>();
  for (const task of [...resumable, ...awaitingRelease, ...awaitingArbitration]) {
    committed.set(task.address, usdcToMicro(costUsdc(task)));
  }
  // A claim made before the reads that they do not list has left the committed states, unless its
  // executor still holds it: then the listing lags a job this process is working. A held reservation
  // (a sent claim that may still land) stays until the reads list it committed or its hold ends: the
  // listing lags the chain, and a job moving between two reads is listed in neither.
  const holds = snapshot.holds();
  const nowMs = nowSeconds() * 1000;
  const holding = (address: string): boolean =>
    !committed.has(address) && nowMs < (holds.get(address) ?? Number.NEGATIVE_INFINITY);
  snapshot.publish(
    committed,
    new Set(
      [...reservedBeforeReads].filter((address) => !executors.has(address) && !holding(address)),
    ),
  );

  // Resume crashed-mid-execute jobs: already claimed on-chain, so DO NOT re-claim.
  for (const task of resumable) {
    // A reservation left after the publish is a claim that began during the reads, and one taken before
    // them may be a 402 hand-off that ran during them: neither is this pass's to resume.
    if (
      heldBeforeReads.has(task.address) ||
      reservedBeforeReads.has(task.address) ||
      executors.has(task.address) ||
      snapshot.reservations().has(task.address)
    ) {
      continue;
    }
    // No await between the check and the take: the 402 hand-off runs between the loop's awaits.
    executors.add(task.address);
    log.info(`[worker] Resuming in-flight job ${task.address} (already claimed on-chain).`);
    try {
      await deliver(task);
    } catch (err) {
      if (err instanceof EscrowStateError) {
        log.warn(`[worker] ${task.address} changed state during resume: ${err.message}`);
        continue;
      }
      log.error(
        `[worker] ${task.address} is claimed but not submitted: manual attention needed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      executors.delete(task.address);
    }
  }

  for (const task of claimable) {
    if (deps.claimRefusal !== undefined) {
      let refusal: string | null;
      try {
        refusal = await deps.claimRefusal(task);
      } catch (err) {
        log.warn(
          `[worker] Refusing ${task.address}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (refusal !== null) {
        log.info(`[worker] Refusing ${task.address}: ${refusal}`);
        continue;
      }
    }
    // After the refusal's await: the 402 path may have taken this escrow while it ran. A reservation
    // the escrow holds is a 402 claim that may still land: claiming would re-reserve it, and release it
    // on a failure.
    if (executors.has(task.address) || snapshot.reservations().has(task.address)) continue;

    // Deadline guard: never claim what we cannot finish in time.
    const canFinish = canFinishBeforeDeadline({
      deadlineUnix: task.deadline,
      estimatedDurationSeconds: durationSeconds(task),
      safetyBufferSeconds: config.deadlineSafetyBufferSeconds,
      nowSeconds: nowSeconds(),
    });
    if (!canFinish) {
      log.info(`[worker] Skipping ${task.address}: not enough time before the deadline.`);
      continue;
    }

    // Float guard: never commit more working capital than the bound allows.
    const proposedMicroUsdc = usdcToMicro(costUsdc(task));
    try {
      assertWithinFloatBound({
        maxConcurrentFloatUsdc: config.maxConcurrentFloatUsdc,
        inFlightMicroUsdc: snapshot.inFlightMicroUsdc(),
        proposedMicroUsdc,
      });
    } catch (err) {
      log.info(
        `[worker] Refusing ${task.address}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // No await between the float check and these two: the 402 path runs between the loop's awaits.
    executors.add(task.address);
    snapshot.reserve(task.address, proposedMicroUsdc);
    let claimed = false;
    try {
      await client.claimTask(task.address);
      claimed = true;
      log.info(`[worker] Claimed ${task.address}.`);
      await deliver(task);
    } catch (err) {
      // An EscroConfirmError is a claim that landed and the API failed to record: it stays counted.
      if (!claimed && !(err instanceof EscroConfirmError)) snapshot.release(task.address);
      if (err instanceof EscrowStateError) {
        log.warn(
          `[worker] State conflict on ${task.address} (claimed by another?): ${err.message}`,
        );
        continue;
      }
      if (claimed) {
        log.error(
          `[worker] ${task.address} is claimed but not submitted: manual attention needed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        continue;
      }
      throw err;
    } finally {
      executors.delete(task.address);
    }
  }
}
