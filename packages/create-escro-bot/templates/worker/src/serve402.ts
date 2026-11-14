// The 402 menu beside the polling loop: an unpaid POST /v1/<capability> answers a 402, a buyer
// funds the escrow and presents it, the claim lands inside that request, and the job runs on the
// same executor as the loop. Only the buyer collects: the paid request and every poll carry the
// buyer's signature. Escro never judges the deliverable. A route with an `exact` price also offers
// a direct payment, settled through the facilitator, whose answer is the work itself.

import { createServer, type Server } from "node:http";
import { CLAIM_HOLD_MS, ClaimRefusedError, createX402Menu } from "@escro/x402-middleware";
import type {
  ClaimedJob,
  ExactAnswer,
  SettleExactRoute,
  X402Menu,
  X402MenuOptions,
  X402Route,
} from "@escro/x402-middleware";
import { x402Handler } from "@escro/x402-middleware/express";
import {
  EscroConfirmError,
  EscroError,
  buildBazaarDeclaration,
  createHttpFacilitator,
} from "@escro/sdk";
import type { EscrowAccount, Facilitator, ServiceAdapter, TaskSpec } from "@escro/sdk";
import type { EscroConfig } from "../escro.config.js";
import { canFinishBeforeDeadline } from "./deadline.js";
import { assertWithinFloatBound, usdcToMicro } from "./float-cap.js";
import type { Storage } from "./storage.js";
import {
  createCommittedSnapshot,
  executeAndSubmit,
  type CommittedSnapshot,
  type ExecuteJob,
  type WorkerClient,
  type WorkerDeps,
  type WorkerLogger,
} from "./worker.js";

/**
 * The job a capability's request describes. Replace it with your own: it must be deterministic per
 * request, because the paid request re-derives the spec and its hash must match the 402's.
 */
export function taskSpecFor(capability: string, body: unknown): TaskSpec {
  return {
    version: "1.0.0",
    taskType: "custom",
    description: `Run ${capability} on the input in metadata.`,
    acceptanceCriteria: [{ id: "ac-1", description: "deliverable produced" }],
    deliverableFormat: { type: "json" },
    metadata: { capability, input: body ?? null },
  };
}

type KitConfig = Pick<
  EscroConfig,
  | "network"
  | "maxConcurrentFloatUsdc"
  | "estimatedServiceCostUsdc"
  | "estimatedDurationSeconds"
  | "deadlineSafetyBufferSeconds"
  | "serve402"
>;

export interface KitClaimHookDeps {
  config: KitConfig;
  client: WorkerClient;
  executors: Set<string>;
  committed: CommittedSnapshot;
  /** Current time, Unix ms. */
  now: () => number;
}

export interface KitMenuDeps extends KitClaimHookDeps {
  /** The wallet `client` signs with. */
  payTo: string;
  rpc: X402MenuOptions["rpc"];
  adapter: ServiceAdapter;
  storage: Storage;
  logger: WorkerLogger;
  /** The spec each job was bought on, kept for the loop's resume until its submit lands. */
  menuSpecs: Map<string, TaskSpec>;
  /** Derives each request's spec. Defaults to this module's `taskSpecFor`; the same contract applies. */
  taskSpecFor?: typeof taskSpecFor;
  executeJob?: ExecuteJob;
  /** What the routes' `exact` prices settle through. Default: one over `serve402.facilitatorUrl`. */
  facilitator?: Facilitator;
}

/** What `loadService` hands the bot: everything it runs on, or why it should idle. */
export type BotService =
  | { idle: string }
  | {
      config: EscroConfig;
      adapter: ServiceAdapter;
      resolveTaskSpec: (t: EscrowAccount) => Promise<TaskSpec>;
      claimRefusal?: WorkerDeps["claimRefusal"];
      taskSpecFor?: KitMenuDeps["taskSpecFor"];
      executeJob?: WorkerDeps["executeJob"];
    };

/** The claim's own signature on a rejection from the send on; a TX_FAILED claim executed and failed. */
function sentSignature(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  if (err instanceof EscroError && err.code === "TX_FAILED") return undefined;
  const own: unknown = Object.getOwnPropertyDescriptor(err, "signature")?.value;
  return typeof own === "string" ? own : undefined;
}

/**
 * The menu's claim: the loop's deadline guard and float bound, failing closed, and one executor per
 * escrow. The reasons reach the buyer, so they carry none of the operator's figures. A claim that
 * lands adds its escrow to `handOffs`: the menu's hand-off then runs on the slot this claim holds.
 */
export function createKitClaimHook(
  deps: KitClaimHookDeps,
  handOffs = new Set<string>(),
): NonNullable<X402MenuOptions["claim"]> {
  const { config, client, executors, committed, now } = deps;
  return async ({ escrow, deadline }) => {
    if (executors.has(escrow)) {
      throw new ClaimRefusedError("this worker is already working this escrow");
    }
    const canFinish = canFinishBeforeDeadline({
      deadlineUnix: deadline,
      estimatedDurationSeconds: config.estimatedDurationSeconds,
      safetyBufferSeconds: config.deadlineSafetyBufferSeconds,
      nowSeconds: Math.floor(now() / 1_000),
    });
    if (!canFinish) throw new ClaimRefusedError("not enough time before the deadline");
    if (!committed.isPublished()) {
      throw new ClaimRefusedError("this worker has not finished its first pass");
    }
    const proposedMicroUsdc = usdcToMicro(config.estimatedServiceCostUsdc);
    try {
      // The escrow's own reservation (an earlier claim of it that may still land) is this claim's cost, charged once.
      assertWithinFloatBound({
        maxConcurrentFloatUsdc: config.maxConcurrentFloatUsdc,
        inFlightMicroUsdc: committed.inFlightMicroUsdc(escrow),
        proposedMicroUsdc,
      });
    } catch {
      throw new ClaimRefusedError("this worker's working capital is committed");
    }

    // No await between the float check and these two: the loop and other requests run at awaits.
    const reservedBefore = committed.reservations().has(escrow);
    executors.add(escrow);
    committed.reserve(escrow, proposedMicroUsdc);
    try {
      const signature = await client.claimTask(escrow);
      handOffs.add(escrow);
      committed.endHold(escrow);
      return signature;
    } catch (err) {
      // An EscroConfirmError is a landed claim the API failed to record: the job still starts.
      if (err instanceof EscroConfirmError) {
        handOffs.add(escrow);
        committed.endHold(escrow);
        throw err;
      }
      executors.delete(escrow);
      // Sent, so it may still land: the float stays charged until a pass lists it or the hold ends.
      if (sentSignature(err) !== undefined) committed.hold(escrow, now() + CLAIM_HOLD_MS);
      else if (!reservedBefore) committed.release(escrow);
      throw err;
    }
  };
}

/**
 * A route's `exact` leg: the adapter's answer to the spec derived from the request, as JSON. It runs on neither the
 * escrow executor set nor the float: the buyer has paid before it starts, and both are keyed by escrow.
 */
function exactLeg(
  adapter: ServiceAdapter,
  exact: { priceUsdc: number; maxTimeoutSeconds: number },
): SettleExactRoute {
  return {
    priceMicroUsdc: BigInt(usdcToMicro(exact.priceUsdc)),
    maxTimeoutSeconds: exact.maxTimeoutSeconds,
    serve: async (job): Promise<ExactAnswer> => {
      const result = await adapter.execute(job.taskSpec);
      const binary = Buffer.isBuffer(result.content);
      return {
        contentType: "application/json",
        body: JSON.stringify({
          contentHash: result.contentHash,
          content: binary ? result.content.toString("base64") : result.content,
          encoding: binary ? "base64" : "utf8",
        }),
      };
    },
  };
}

/** The menu over `serve402.routes`, one POST /v1/<capability> each; throws on a refused configuration. */
export function createKitMenu(deps: KitMenuDeps): X402Menu {
  const {
    config,
    client,
    rpc,
    payTo,
    adapter,
    storage,
    executors,
    committed,
    menuSpecs,
    logger,
    now,
  } = deps;
  const specFor = deps.taskSpecFor ?? taskSpecFor;
  const { publicUrl, routes, facilitatorUrl, serviceName, tags, iconUrl } = config.serve402;
  if (publicUrl === undefined) {
    throw new Error("serve402.publicUrl is required to build the 402 menu.");
  }
  // A catalog probes a declared route with its example body and must get a 402.
  for (const { capability, discovery } of routes) {
    if (discovery === undefined) continue;
    try {
      specFor(capability, discovery.input);
    } catch (err) {
      throw new Error(
        `serve402 route "${capability}": discovery.input is refused by taskSpecFor: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  let facilitator: Facilitator | undefined;
  if (routes.some((route) => route.exact !== undefined)) {
    // executeJob is keyed by an escrow, which an exact payment does not have.
    if (deps.executeJob !== undefined) {
      throw new Error("A service with executeJob cannot serve a route with an exact price.");
    }
    if (deps.facilitator !== undefined) facilitator = deps.facilitator;
    else if (facilitatorUrl !== undefined)
      facilitator = createHttpFacilitator({ url: facilitatorUrl });
    else throw new Error("serve402.facilitatorUrl is required by a route with an exact price.");
  }

  const handOffs = new Set<string>();

  // The 202 has already answered: a failure here is logged and the escrow released, so a later pass
  // (the next one skips an escrow reserved before its reads) resumes the job on the chain's word and
  // this request's spec.
  const onClaimed = async (job: ClaimedJob): Promise<void> => {
    // A claim that landed after the hook threw: the hook let its slot go, so the hand-off takes it,
    // unless the loop is already working the escrow. No await before the take.
    if (!handOffs.delete(job.escrow)) {
      if (executors.has(job.escrow)) {
        logger.info(`[worker] ${job.escrow} is already being worked; the hand-off is skipped`);
        return;
      }
      executors.add(job.escrow);
      // Seen by a pass whose reads this hand-off runs during; a later pass settles it.
      committed.reserve(job.escrow, usdcToMicro(config.estimatedServiceCostUsdc));
    }
    menuSpecs.set(job.escrow, job.taskSpec);
    try {
      await executeAndSubmit(
        {
          adapter,
          storage,
          logger,
          submit: (address, params) => menu.submit(address, params),
          ...(deps.executeJob !== undefined && { executeJob: deps.executeJob }),
        },
        job.escrow,
        job.taskSpec,
      );
      menuSpecs.delete(job.escrow);
    } catch (err) {
      logger.error(
        `[worker] ${job.escrow} is claimed but not submitted; a later pass resumes it: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      executors.delete(job.escrow);
    }
  };

  const menuRoutes: X402Route[] = routes.map(({ capability, priceUsdc, exact, discovery }) => ({
    method: "POST",
    path: `/v1/${capability}`,
    priceMicroUsdc: BigInt(usdcToMicro(priceUsdc)),
    workSeconds: config.estimatedDurationSeconds + config.deadlineSafetyBufferSeconds,
    taskSpec: (request) => specFor(capability, request.body),
    onClaimed,
    ...(exact === undefined ? {} : { settleExact: exactLeg(adapter, exact) }),
    ...(discovery === undefined
      ? {}
      : {
          description: discovery.description,
          bazaar: buildBazaarDeclaration({
            method: "POST",
            example: discovery.input,
            ...(discovery.output === undefined ? {} : { output: discovery.output }),
          }),
        }),
  }));
  const service = {
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(tags === undefined ? {} : { tags }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
  };

  const menu = createX402Menu({
    cluster: config.network,
    payTo,
    escro: client,
    rpc,
    publicUrl,
    routes: menuRoutes,
    claim: createKitClaimHook(deps, handOffs),
    now,
    ...(facilitator === undefined ? {} : { facilitator }),
    ...(Object.keys(service).length === 0 ? {} : { service }),
  });
  return menu;
}

export type KitLoopDeps = Required<
  Pick<WorkerDeps, "executors" | "committed" | "menuSpecs" | "submit">
>;

/** The menu and the deps that make the loop share its state: one executor set, float and submit. */
export function createKit402(deps: Omit<KitMenuDeps, "executors" | "committed" | "menuSpecs">): {
  menu: X402Menu;
  loopDeps: KitLoopDeps;
} {
  const executors = new Set<string>();
  const committed = createCommittedSnapshot();
  const menuSpecs = new Map<string, TaskSpec>();
  const menu = createKitMenu({ ...deps, executors, committed, menuSpecs });
  return {
    menu,
    loopDeps: {
      executors,
      committed,
      menuSpecs,
      submit: (address, params) => menu.submit(address, params),
    },
  };
}

/** Serves `menu` over node:http until the process ends; resolves once it is listening. */
export function startServer(
  menu: X402Menu,
  options: { host: string; port: number },
): Promise<Server> {
  const handler = x402Handler(menu);
  const server = createServer((req, res) => {
    handler(req, res, (err) => {
      if (err !== undefined) {
        console.error(
          `[worker] a 402 menu request failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
      res.writeHead(err === undefined ? 404 : 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err === undefined ? "not_found" : "internal_error" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
