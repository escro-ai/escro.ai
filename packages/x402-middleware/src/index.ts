import type {
  Acceptance,
  BazaarDeclaration,
  Escro,
  EscroOptions,
  EscroReceipt,
  Facilitator,
  PaymentRequirements,
  ReplayStore,
  TaskSpec,
  VerifyEscrowContext,
} from "@escro/sdk";

export type MenuCluster = EscroOptions["cluster"];

export interface MenuRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The parsed JSON value for application/json, undefined for no body, else the UTF-8 string. */
  body: unknown;
}

/** What a route's 402 carries in `extensions.escro`; `false` carries no extension. */
export type RouteExtension =
  | false
  | { acceptance?: Acceptance; receipt?: EscroReceipt; mcpServer?: string };

export interface X402Route {
  method: "GET" | "POST";
  /** Starts with "/", no query; unique per method. */
  path: string;
  /** Refused below the minimum escrow at createX402Menu. */
  priceMicroUsdc: bigint;
  /** The time the work takes; a positive safe integer. */
  workSeconds: number;
  /** Default 120. */
  maxTimeoutSeconds?: number;
  /** Default 2 592 000 (the API's 30-day bound). */
  maxDeadlineSeconds?: number;
  /** At most 500 UTF-8 bytes, well-formed, no control character; carried as `resource.description`. */
  description?: string;
  mimeType?: string;
  /** Deterministic per request: a paid request re-derives the job from it. */
  taskSpec(request: MenuRequest): TaskSpec | Promise<TaskSpec>;
  /**
   * Entries of other schemes, offered after the `on-delivery` entry byte-identical. Configuring one is the operator's
   * assertion that a verifier for that scheme is mounted after this middleware. A function is also called to decide
   * whether a presented scheme passes on; for that call `body` is undefined, so the body stays unread for the next
   * handler.
   */
  exact?: PaymentRequirements[] | ((request: MenuRequest) => PaymentRequirements[]);
  /**
   * A direct `exact` payment beside the `on-delivery` entry, settled through `X402MenuOptions.facilitator`: the
   * cluster's USDC paid to `payTo`, the work answered inside the paid request. Not beside `exact`.
   */
  settleExact?: SettleExactRoute;
  extension?: RouteExtension;
  /**
   * Carried as `extensions.bazaar` in every 402 of this route, whatever `extension` says, and forwarded to the
   * facilitator with a paid `exact` request. Build it with the SDK's `buildBazaarDeclaration`.
   */
  bazaar?: BazaarDeclaration;
  /** Runs once, after the claim landed; not awaited by the 202. A rejection records the job "failed". */
  onClaimed(job: ClaimedJob): void | Promise<void>;
}

export interface SettleExactRoute {
  /** Positive, at most 2^64 - 1; no escrow minimum applies. */
  priceMicroUsdc: bigint;
  /** Default 120, from 10 to 3600. The whole paid answer is due within it, one second before it ends. */
  maxTimeoutSeconds?: number;
  /**
   * Runs at most once per settled payment, after the settle; `signal` aborts at the answer deadline, when the buyer
   * is answered 504 with the settlement's PAYMENT-RESPONSE. A rejection answers 500, with it too.
   */
  serve(
    job: { request: MenuRequest; taskSpec: TaskSpec },
    signal: AbortSignal,
  ): Promise<ExactAnswer>;
}

/** The paid `exact` request's 200: its content type and body. */
export interface ExactAnswer {
  contentType: string;
  body: string | Uint8Array;
}

export interface ClaimedJob {
  escrow: string;
  buyer: string;
  taskSpec: TaskSpec;
  /** The escrow's on-chain deadline, Unix seconds. */
  deadline: number;
  claimSignature: string;
  route: string;
}

export interface JobRecord {
  escrow: string;
  /** Absent on a record no presentation has named a buyer for; such a record is served to nobody. */
  buyer?: string;
  route: string;
  status: "claimed" | "submitted" | "failed";
  claimSignature?: string;
  submitSignature?: string;
  contentHash?: string;
  proofUri?: string;
  error?: string;
}

export interface JobStore {
  get(escrow: string): JobRecord | undefined | Promise<JobRecord | undefined>;
  put(record: JobRecord): void | Promise<void>;
}

export interface ClaimHookJob {
  escrow: string;
  buyer: string;
  deadline: number;
  route: string;
}

/** The status read the menu makes for a claim whose outcome is unknown; a web3.js `Connection` satisfies it. */
export interface SignatureStatusRpc {
  getSignatureStatuses(
    signatures: string[],
    config: { searchTransactionHistory: boolean },
  ): Promise<{
    value: ({
      err: unknown;
      confirmationStatus?: "processed" | "confirmed" | "finalized";
    } | null)[];
  }>;
}

export interface X402MenuOptions {
  cluster: MenuCluster;
  /** The wallet `escro` signs with. */
  payTo: string;
  /**
   * An `Escro` satisfies it; a hand-built client must implement `confirm` too. The menu calls `confirm` only to have
   * the API record a claim of its own that threw and that the status read then showed landed.
   */
  escro: Pick<Escro, "claimTask" | "submitDeliverable" | "confirm">;
  /**
   * Reads accounts and, for a claim that threw carrying its signature, that signature's status; a web3.js
   * `Connection` satisfies it.
   */
  rpc: VerifyEscrowContext["rpc"] & SignatureStatusRpc;
  /** An https: origin: scheme, host and optional port, no path. */
  publicUrl: string;
  routes: X402Route[];
  /** Default "/specs". */
  specPath?: string;
  /** Default "/v1/jobs". */
  pollPath?: string;
  /** Default memoryReplayStore(), per menu; a multi-process server passes a shared one. */
  replay?: ReplayStore;
  /** Default memoryJobStore(), per menu; a multi-process server passes a shared one. */
  jobs?: JobStore;
  /** Default 1024. */
  maxSpecs?: number;
  /** Default 60 000. */
  feeCacheMs?: number;
  /** Default 65 536. */
  maxBodyBytes?: number;
  /**
   * Default: `escro.claimTask(escrow)`. A custom hook resolves only after the claim is confirmed; throwing
   * {@link ClaimRefusedError} refuses the job before any claim. A rejection's own `signature` property, when it has
   * one, must be this claim's own transaction: the menu reads its status and hands off the job if it landed.
   */
  claim?: (job: ClaimHookJob) => Promise<string>;
  /** Unix milliseconds. */
  now?: () => number;
  /** What a route's `settleExact` settles through; required by any route that sets it. */
  facilitator?: Facilitator;
  /** How long a successful `/supported` read is reused, a positive integer of milliseconds. Default 300 000. */
  facilitatorCacheMs?: number;
  /** The 402 `resource`'s service metadata, on every route. */
  service?: { serviceName?: string; tags?: string[]; iconUrl?: string };
}

export interface X402Menu {
  /** Answers a request this menu owns; undefined for any other path and for a pass-through. */
  fetch(request: Request): Promise<Response | undefined>;
  /** submit_deliverable through the injected client; records the job "submitted". */
  submit(escrow: string, result: { contentHash: string; proofUri?: string }): Promise<string>;
  /** Where the menu serves its spec and poll routes, for an adapter that registers them with its framework. */
  readonly paths: { readonly spec: string; readonly poll: string };
}

export { CLAIM_HOLD_MS, createX402Menu } from "./menu.js";
export { memoryJobStore } from "./job-store.js";
export { claimSettlement, escrowAccept } from "./accept.js";
export type { BuiltEscrowAccept, ClaimSettlementInput, EscrowAcceptOptions } from "./accept.js";
export { ClaimRefusedError } from "./errors.js";
