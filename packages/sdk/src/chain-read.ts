// Reads what the program recorded for one escrow straight from a Solana RPC, with no Escro service
// in the path: an open escrow from its account, a closed one (every settlement closes the account)
// from the program's events in the address's transaction history. Nothing signs, nothing writes.
import bs58 from "bs58";
import { Connection, PublicKey, SolanaJSONRPCErrorCode, SystemProgram } from "@solana/web3.js";
import {
  CURRENT_ACCOUNT_VERSION,
  EscrowState,
  assertProgramIdNotPlaceholder,
  escrowFee,
  getProgramId,
  type SolanaCluster,
} from "@escro/shared";
import { deriveEscrowPda } from "@escro/shared/solana";
import {
  LogTruncatedError,
  MAX_SUPPORTED_TRANSACTION_VERSION,
  decodeEscroEvent,
  transactionVersionFetch,
  walkProgramLogs,
  type EscroEvent,
} from "@escro/shared/chain";
import { EscroError } from "./errors.js";

/**
 * The RPC methods the reader calls; a web3.js Connection satisfies it. A history holding a
 * version-1 transaction reads only through a connection {@link chainReadConnection} builds; a
 * custom transport (headers, a proxy, a test double) goes in as its `fetchFn`. A connection built
 * any other way fails a version-1 history with `CHAIN_RPC_FAILED`, whose archival advice does not
 * apply to that failure.
 */
export type ChainReadRpc = Pick<
  Connection,
  "getAccountInfo" | "getSignaturesForAddress" | "getTransaction"
>;

export type ChainReadTarget = { address: string } | { buyer: string; taskId: string };

export interface ReadEscrowFromChainOptions {
  /** Selects the program id through `getProgramId`; a localnet run of the devnet build is "devnet". */
  cluster: SolanaCluster;
  /**
   * The RPC read. A history holding a version-1 transaction reads only through a connection
   * {@link chainReadConnection} builds; a custom transport (headers, a proxy, a test double) goes
   * in as its `fetchFn`. A connection built any other way fails a version-1 history with
   * `CHAIN_RPC_FAILED`, whose archival advice does not apply to that failure.
   */
  rpc: ChainReadRpc;
  /** The most getTransaction calls one read makes; default {@link CHAIN_READ_MAX_TRANSACTIONS}. */
  maxTransactions?: number;
}

/** Every EscrowAccount field by its IDL name (snake_case), u64 as bigint, i64 as number, pubkeys base58. */
export type DecodedEscrowAccount = Record<string, string | number | bigint | null>;

export interface ChainEscrowFigures {
  address: string;
  buyer: string;
  worker: string | null;
  taskId: string;
  amountMicro: bigint;
  feeBps: number;
  /** `escrowFee(amountMicro, feeBps)`, the escrow's own stored rate. */
  feeMicro: bigint;
  /** What the buyer deposited: amount plus fee. */
  depositMicro: bigint;
  deadline: number;
  specHash: string;
  createdAt: number;
  deliverableHash: string | null;
  proofUri: string | null;
  submittedAt: number | null;
}

export interface ChainSettlement {
  kind: "released" | "refunded" | "cancelled";
  /** PaymentReleased.worker_amount. */
  workerAmountMicro: bigint | null;
  /** PaymentReleased.fee_amount. */
  feeAmountMicro: bigint | null;
  /** BuyerRefunded or EscrowCancelled refund_amount. */
  refundAmountMicro: bigint | null;
  /** The event's resolved_at, or cancelled_at for a cancel. */
  resolvedAt: number;
  /** The settling transaction. */
  signature: string;
}

export interface ChainEscrowReading {
  source: "account" | "history";
  cluster: SolanaCluster;
  programId: string;
  /** FUNDED to DISPUTED while open; COMPLETED, REFUNDED or CANCELLED once closed. */
  state: EscrowState;
  /** From an account, the state is DISPUTED; from history, a DisputeRaised is in the lifecycle. */
  disputed: boolean;
  figures: ChainEscrowFigures;
  /** Null while open. */
  settlement: ChainSettlement | null;
  /** From history, the lifecycle's successful transactions, oldest first; from an account, none. */
  signatures: string[];
}

export type ChainReadErrorCode =
  | "CHAIN_ESCROW_NOT_FOUND"
  | "CHAIN_HISTORY_INCOMPLETE"
  | "CHAIN_HISTORY_BUDGET"
  | "CHAIN_LOGS_TRUNCATED"
  | "CHAIN_ACCOUNT_INVALID"
  | "CHAIN_RPC_FAILED"
  | "CHAIN_TRANSACTION_VERSION"
  | "INVALID_INPUT";

export type ChainAccountInvalidReason = "owner" | "discriminator" | "version" | "layout" | "pda";

/**
 * A chain read that gave no reading. `reason` names the failed account check on
 * `CHAIN_ACCOUNT_INVALID`. A `CHAIN_RPC_FAILED` message is fixed text naming the RPC method, a
 * `CHAIN_TRANSACTION_VERSION` one the transaction and the address; the transport's own error, which
 * may echo the RPC URL, is only the `cause`.
 */
export class ChainReadError extends EscroError {
  readonly reason: ChainAccountInvalidReason | undefined;

  constructor(
    code: ChainReadErrorCode,
    message: string,
    options: { reason?: ChainAccountInvalidReason; cause?: unknown } = {},
  ) {
    super(message, code, undefined, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "ChainReadError";
    this.reason = options.reason;
  }
}

export const ARCHIVAL_RPC_NOTE =
  "A settled escrow is closed on chain and survives only in transaction history; if it is older than this RPC's history, read it through an archival RPC.";

/** getTransaction calls per read: one lifecycle takes at most five, so about ten reuses or spam. */
export const CHAIN_READ_MAX_TRANSACTIONS = 50;
/** getSignaturesForAddress pages per read, of {@link SIGNATURE_PAGE} signatures each. */
export const CHAIN_READ_MAX_SIGNATURE_PAGES = 5;
const SIGNATURE_PAGE = 1000;

export const ESCROW_ACCOUNT_DISCRIMINATOR: readonly number[] = [36, 69, 48, 18, 128, 225, 125, 135];

type FieldKind =
  | "pubkey"
  | "u8"
  | "u16"
  | "u64"
  | "i64"
  | "string"
  | "option<pubkey>"
  | "option<string>"
  | "option<i64>"
  | "enum";

/** The EscrowAccount fields in on-chain order (escrow_account.rs, the committed IDL). */
export const ESCROW_ACCOUNT_LAYOUT: readonly { name: string; kind: FieldKind }[] = [
  { name: "version", kind: "u8" },
  { name: "buyer", kind: "pubkey" },
  { name: "assigned_worker", kind: "option<pubkey>" },
  { name: "task_id", kind: "string" },
  { name: "amount_usdc", kind: "u64" },
  { name: "fee_bps", kind: "u16" },
  { name: "deadline", kind: "i64" },
  { name: "spec_hash", kind: "string" },
  { name: "deliverable_hash", kind: "option<string>" },
  { name: "proof_uri", kind: "option<string>" },
  { name: "state", kind: "enum" },
  { name: "created_at", kind: "i64" },
  { name: "updated_at", kind: "i64" },
  { name: "submitted_at", kind: "option<i64>" },
  { name: "min_amount", kind: "u64" },
  { name: "bump", kind: "u8" },
  { name: "marketplace_id", kind: "option<string>" },
  { name: "referrer_wallet", kind: "option<pubkey>" },
  { name: "referrer_bps", kind: "u16" },
];

/** The program's allocation: 8 + EscrowAccount::INIT_SPACE. The tail past the content is zero. */
export const ESCROW_ACCOUNT_SIZE = 537;

/** The IDL's EscrowState variants, in discriminant order. */
const STATE_VARIANTS = [
  "Created",
  "Funded",
  "InProgress",
  "Submitted",
  "Completed",
  "Disputed",
  "Refunded",
] as const;

const STATE_OF: Record<(typeof STATE_VARIANTS)[number], EscrowState> = {
  Created: EscrowState.CREATED,
  Funded: EscrowState.FUNDED,
  InProgress: EscrowState.IN_PROGRESS,
  Submitted: EscrowState.SUBMITTED,
  Completed: EscrowState.COMPLETED,
  Disputed: EscrowState.DISPUTED,
  Refunded: EscrowState.REFUNDED,
};

const MAX_TASK_ID_BYTES = 32;

class AccountProblem extends Error {
  constructor(
    readonly reason: ChainAccountInvalidReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

class AccountReader {
  private at = 0;
  constructor(private readonly data: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.at + n > this.data.length) {
      throw new AccountProblem("layout", "a field reads past the content");
    }
    const bytes = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return bytes;
  }

  private view(n: number): DataView {
    const bytes = this.take(n);
    return new DataView(bytes.buffer, bytes.byteOffset, n);
  }

  skip(n: number): void {
    this.take(n);
  }

  private scalar(kind: "pubkey" | "string" | "i64"): string | number {
    if (kind === "pubkey") return bs58.encode(this.take(32));
    if (kind === "string") {
      const length = this.view(4).getUint32(0, true);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
      } catch (err) {
        if (err instanceof AccountProblem) throw err;
        throw new AccountProblem("layout", "a string field is not UTF-8");
      }
    }
    const value = this.view(8).getBigInt64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new AccountProblem("layout", "an i64 field is outside the safe integer range");
    }
    return Number(value);
  }

  read(kind: FieldKind): string | number | bigint | null {
    switch (kind) {
      case "u8":
        return this.view(1).getUint8(0);
      case "u16":
        return this.view(2).getUint16(0, true);
      case "u64":
        return this.view(8).getBigUint64(0, true);
      case "pubkey":
      case "string":
      case "i64":
        return this.scalar(kind);
      case "enum": {
        const index = this.view(1).getUint8(0);
        const variant = STATE_VARIANTS[index];
        if (variant === undefined) {
          throw new AccountProblem("layout", `state ${String(index)} is no EscrowState variant`);
        }
        return variant;
      }
      case "option<pubkey>":
      case "option<string>":
      case "option<i64>": {
        const tag = this.view(1).getUint8(0);
        if (tag === 0) return null;
        if (tag !== 1) throw new AccountProblem("layout", `an option tag is ${String(tag)}`);
        return this.scalar(
          kind === "option<pubkey>" ? "pubkey" : kind === "option<string>" ? "string" : "i64",
        );
      }
    }
  }
}

/** Checks run in order: discriminator, version, layout. */
function decodeAccount(data: Uint8Array): DecodedEscrowAccount {
  if (
    data.length < ESCROW_ACCOUNT_DISCRIMINATOR.length ||
    ESCROW_ACCOUNT_DISCRIMINATOR.some((byte, i) => data[i] !== byte)
  ) {
    throw new AccountProblem("discriminator", "its discriminator is not EscrowAccount's");
  }
  const version = data[ESCROW_ACCOUNT_DISCRIMINATOR.length];
  if (version !== undefined && version !== CURRENT_ACCOUNT_VERSION) {
    throw new AccountProblem(
      "version",
      `its version is ${String(version)}; this reader reads version ${String(CURRENT_ACCOUNT_VERSION)}`,
    );
  }
  if (data.length !== ESCROW_ACCOUNT_SIZE) {
    throw new AccountProblem(
      "layout",
      `it is ${String(data.length)} bytes; an EscrowAccount is ${String(ESCROW_ACCOUNT_SIZE)}`,
    );
  }
  const reader = new AccountReader(data);
  reader.skip(ESCROW_ACCOUNT_DISCRIMINATOR.length);
  const decoded: DecodedEscrowAccount = {};
  for (const field of ESCROW_ACCOUNT_LAYOUT) decoded[field.name] = reader.read(field.kind);
  return decoded;
}

/**
 * Decode EscrowAccount bytes as the program allocates them. Throws {@link ChainReadError}
 * `CHAIN_ACCOUNT_INVALID` (reason `discriminator`, `version` or `layout`) on anything else.
 * `state` is the IDL variant name (`Funded`, `InProgress`, ...).
 */
export function decodeEscrowAccount(data: Uint8Array): DecodedEscrowAccount {
  try {
    return decodeAccount(data);
  } catch (err) {
    if (!(err instanceof AccountProblem)) throw err;
    throw new ChainReadError(
      "CHAIN_ACCOUNT_INVALID",
      `Not a current EscrowAccount: ${err.detail}`,
      { reason: err.reason },
    );
  }
}

// ── Targets ───────────────────────────────────────────────────────────────────

function invalidInput(message: string): ChainReadError {
  return new ChainReadError("INVALID_INPUT", message);
}

/** A canonical base58 key; the refusal never repeats the input, which may be hostile text. */
function parsedKey(value: unknown, what: string): PublicKey {
  let key: PublicKey | null = null;
  if (typeof value === "string") {
    try {
      key = new PublicKey(value);
    } catch {
      key = null;
    }
  }
  if (key === null || key.toBase58() !== value) {
    throw invalidInput(`The ${what} is not a base58 public key`);
  }
  return key;
}

/** Validated before any RPC call: exactly one target form, canonical keys, a seed-sized task id. */
function resolveTarget(target: ChainReadTarget, programId: PublicKey): PublicKey {
  const t = target as Partial<Record<"address" | "buyer" | "taskId", unknown>>;
  const byAddress = t.address !== undefined;
  const byTask = t.buyer !== undefined || t.taskId !== undefined;
  if (byAddress === byTask || (byTask && (t.buyer === undefined || t.taskId === undefined))) {
    throw invalidInput("Give either an address or a buyer with a task id");
  }
  if (byAddress) return parsedKey(t.address, "address");
  const buyer = parsedKey(t.buyer, "buyer");
  if (typeof t.taskId !== "string") throw invalidInput("The task id is not a string");
  const bytes = new TextEncoder().encode(t.taskId).length;
  if (bytes > MAX_TASK_ID_BYTES) {
    throw invalidInput(
      `The task id is ${String(bytes)} bytes in UTF-8; an escrow's task id is at most ${String(MAX_TASK_ID_BYTES)}`,
    );
  }
  return deriveEscrowPda(programId, buyer, t.taskId);
}

// ── RPC ───────────────────────────────────────────────────────────────────────

type ReadMethod = keyof ChainReadRpc;

/**
 * A connection at `rpcUrl` and `confirmed` through which a history holding version-1 transactions
 * reads, a custom transport (headers, a proxy, a test double) going in as `fetchFn` (default
 * `globalThis.fetch`, resolved when called); a connection built any other way fails a version-1
 * history with `CHAIN_RPC_FAILED`, whose archival advice does not apply to that failure.
 */
export function chainReadConnection(rpcUrl: string, fetchFn?: typeof globalThis.fetch): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: transactionVersionFetch(fetchFn ?? globalThis.fetch),
  });
}

function rpcFailed(method: ReadMethod, cause: unknown): ChainReadError {
  const note = method === "getAccountInfo" ? "" : ` ${ARCHIVAL_RPC_NOTE}`;
  return new ChainReadError("CHAIN_RPC_FAILED", `The RPC's ${method} call failed.${note}`, {
    cause,
  });
}

async function call<T>(method: ReadMethod, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw rpcFailed(method, cause);
  }
}

/** Whether the RPC refused a transaction above the version the read asked. */
const isVersionRefusal = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION;

/** Transaction `signature` in the history of `at`, at every version the reader reads. */
async function readTransaction(rpc: ChainReadRpc, signature: string, at: string) {
  try {
    return await rpc.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
    });
  } catch (cause) {
    if (isVersionRefusal(cause)) {
      throw new ChainReadError(
        "CHAIN_TRANSACTION_VERSION",
        `Transaction ${signature} in the history of ${at} is of a transaction version this reader does not read (it reads legacy, 0 and 1); its events cannot be read`,
        { cause },
      );
    }
    throw rpcFailed("getTransaction", cause);
  }
}

// ── The open path ─────────────────────────────────────────────────────────────

function stringOf(decoded: DecodedEscrowAccount, name: string): string {
  const value = decoded[name];
  if (typeof value !== "string") throw new Error(`EscrowAccount.${name} is not a string`);
  return value;
}

function optionalString(decoded: DecodedEscrowAccount, name: string): string | null {
  return decoded[name] === null ? null : stringOf(decoded, name);
}

function numberOf(decoded: DecodedEscrowAccount, name: string): number {
  const value = decoded[name];
  if (typeof value !== "number") throw new Error(`EscrowAccount.${name} is not a number`);
  return value;
}

function bigintOf(decoded: DecodedEscrowAccount, name: string): bigint {
  const value = decoded[name];
  if (typeof value !== "bigint") throw new Error(`EscrowAccount.${name} is not a u64`);
  return value;
}

function figures(base: Omit<ChainEscrowFigures, "feeMicro" | "depositMicro">): ChainEscrowFigures {
  const feeMicro = escrowFee(base.amountMicro, base.feeBps);
  return { ...base, feeMicro, depositMicro: base.amountMicro + feeMicro };
}

function readAccount(
  address: PublicKey,
  owner: PublicKey,
  data: Uint8Array,
  programId: PublicKey,
  cluster: SolanaCluster,
): ChainEscrowReading {
  const at = address.toBase58();
  const refuse = (problem: AccountProblem): ChainReadError =>
    new ChainReadError(
      "CHAIN_ACCOUNT_INVALID",
      `The account at ${at} is not a current EscrowAccount: ${problem.detail}`,
      { reason: problem.reason },
    );
  if (!owner.equals(programId)) {
    throw refuse(
      new AccountProblem(
        "owner",
        `it is owned by ${owner.toBase58()}, not the program ${programId.toBase58()}`,
      ),
    );
  }
  let decoded: DecodedEscrowAccount;
  try {
    decoded = decodeAccount(data);
  } catch (err) {
    if (err instanceof AccountProblem) throw refuse(err);
    throw err;
  }
  const buyer = stringOf(decoded, "buyer");
  const taskId = stringOf(decoded, "task_id");
  const derived =
    new TextEncoder().encode(taskId).length <= MAX_TASK_ID_BYTES
      ? deriveEscrowPda(programId, new PublicKey(buyer), taskId)
      : null;
  if (!derived?.equals(address)) {
    throw refuse(new AccountProblem("pda", "its buyer and task id do not derive this address"));
  }
  const variant = stringOf(decoded, "state") as (typeof STATE_VARIANTS)[number];
  const state = STATE_OF[variant];
  return {
    source: "account",
    cluster,
    programId: programId.toBase58(),
    state,
    disputed: state === EscrowState.DISPUTED,
    figures: figures({
      address: at,
      buyer,
      worker: optionalString(decoded, "assigned_worker"),
      taskId,
      amountMicro: bigintOf(decoded, "amount_usdc"),
      feeBps: numberOf(decoded, "fee_bps"),
      deadline: numberOf(decoded, "deadline"),
      specHash: stringOf(decoded, "spec_hash"),
      createdAt: numberOf(decoded, "created_at"),
      deliverableHash: optionalString(decoded, "deliverable_hash"),
      proofUri: optionalString(decoded, "proof_uri"),
      submittedAt: decoded.submitted_at === null ? null : numberOf(decoded, "submitted_at"),
    }),
    settlement: null,
    signatures: [],
  };
}

// ── The closed path ───────────────────────────────────────────────────────────

interface LifecycleTransaction {
  signature: string;
  events: EscroEvent[];
}

function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** The program's events for `address` in one transaction's logs, in log order. */
function eventsFor(
  logs: readonly string[],
  programId: string,
  address: string,
  signature: string,
): EscroEvent[] {
  const unreadable = (detail: string): ChainReadError =>
    new ChainReadError(
      "CHAIN_LOGS_TRUNCATED",
      `Transaction ${signature} in the history of ${address} ${detail}; its events cannot be read`,
    );
  let walked;
  try {
    walked = walkProgramLogs(logs, programId);
  } catch (err) {
    if (err instanceof LogTruncatedError) throw unreadable("has truncated logs");
    throw unreadable("has logs whose frames do not nest");
  }
  const events: EscroEvent[] = [];
  for (const line of walked.events) {
    let event: EscroEvent | null;
    try {
      event = decodeEscroEvent(base64Bytes(line.data));
    } catch {
      throw unreadable("logs an event that does not decode");
    }
    if (event !== null && event.escrow === address) events.push(event);
  }
  return events;
}

/**
 * The newest lifecycle at `address`: the listing newest first (block order, never re-sorted),
 * failed entries skipped unfetched, back to the transaction holding the newest EscrowCreated.
 */
async function readLifecycle(
  rpc: ChainReadRpc,
  address: PublicKey,
  programId: string,
  maxTransactions: number,
): Promise<LifecycleTransaction[]> {
  const at = address.toBase58();
  const newestFirst: LifecycleTransaction[] = [];
  let pages = 0;
  let fetched = 0;
  let listed = false;
  let before: string | undefined;
  for (;;) {
    if (pages === CHAIN_READ_MAX_SIGNATURE_PAGES) {
      throw new ChainReadError(
        "CHAIN_HISTORY_BUDGET",
        `Reading the history of ${at} needs more than ${String(CHAIN_READ_MAX_SIGNATURE_PAGES)} pages of ${String(SIGNATURE_PAGE)} signatures`,
      );
    }
    const page = await call("getSignaturesForAddress", () =>
      rpc.getSignaturesForAddress(
        address,
        { limit: SIGNATURE_PAGE, ...(before !== undefined && { before }) },
        "confirmed",
      ),
    );
    pages += 1;
    if (page.length > 0) listed = true;
    for (const entry of page) {
      if (entry.err !== null) continue;
      if (fetched === maxTransactions) {
        throw new ChainReadError(
          "CHAIN_HISTORY_BUDGET",
          `Reading the history of ${at} needs more than ${String(maxTransactions)} transactions`,
        );
      }
      const tx = await readTransaction(rpc, entry.signature, at);
      fetched += 1;
      if (tx === null) {
        throw new ChainReadError(
          "CHAIN_HISTORY_INCOMPLETE",
          `This RPC does not serve transaction ${entry.signature} in the history of ${at}. ${ARCHIVAL_RPC_NOTE}`,
        );
      }
      if (tx.meta === null) {
        throw new ChainReadError(
          "CHAIN_HISTORY_INCOMPLETE",
          `This RPC serves transaction ${entry.signature} in the history of ${at} without its logs. ${ARCHIVAL_RPC_NOTE}`,
        );
      }
      if (tx.meta.err !== null) continue;
      const logs = tx.meta.logMessages;
      if (logs === null || logs === undefined) {
        throw new ChainReadError(
          "CHAIN_HISTORY_INCOMPLETE",
          `This RPC serves transaction ${entry.signature} in the history of ${at} without its logs. ${ARCHIVAL_RPC_NOTE}`,
        );
      }
      const events = eventsFor(logs, programId, at, entry.signature);
      const created = events.map((e) => e.name).lastIndexOf("EscrowCreated");
      if (created !== -1) {
        newestFirst.push({ signature: entry.signature, events: events.slice(created) });
        return newestFirst.reverse();
      }
      if (events.length > 0) newestFirst.push({ signature: entry.signature, events });
    }
    const last = page.at(-1);
    if (page.length < SIGNATURE_PAGE || last === undefined) break;
    before = last.signature;
  }
  if (!listed) {
    throw new ChainReadError(
      "CHAIN_ESCROW_NOT_FOUND",
      `No account and no transaction at ${at} on this RPC. ${ARCHIVAL_RPC_NOTE}`,
    );
  }
  throw new ChainReadError(
    "CHAIN_HISTORY_INCOMPLETE",
    `The history of ${at} on this RPC does not reach the EscrowCreated of its latest lifecycle. ${ARCHIVAL_RPC_NOTE}`,
  );
}

function readHistory(
  lifecycle: LifecycleTransaction[],
  address: string,
  programId: string,
  cluster: SolanaCluster,
): ChainEscrowReading {
  const events = lifecycle.flatMap((t) =>
    t.events.map((event) => ({ event, signature: t.signature })),
  );
  const create = events[0]?.event;
  const last = events.at(-1);
  if (create?.name !== "EscrowCreated" || last === undefined) {
    throw new Error(`the lifecycle of ${address} does not open with EscrowCreated`);
  }
  let settlement: ChainSettlement;
  let state: EscrowState;
  const settled = last.event;
  if (settled.name === "PaymentReleased") {
    state = EscrowState.COMPLETED;
    settlement = {
      kind: "released",
      workerAmountMicro: settled.workerAmount,
      feeAmountMicro: settled.feeAmount,
      refundAmountMicro: null,
      resolvedAt: settled.resolvedAt,
      signature: last.signature,
    };
  } else if (settled.name === "BuyerRefunded" || settled.name === "EscrowCancelled") {
    const cancelled = settled.name === "EscrowCancelled";
    state = cancelled ? EscrowState.CANCELLED : EscrowState.REFUNDED;
    settlement = {
      kind: cancelled ? "cancelled" : "refunded",
      workerAmountMicro: null,
      feeAmountMicro: null,
      refundAmountMicro: settled.refundAmount,
      resolvedAt: cancelled ? settled.cancelledAt : settled.resolvedAt,
      signature: last.signature,
    };
  } else {
    throw new ChainReadError(
      "CHAIN_HISTORY_INCOMPLETE",
      `The latest lifecycle at ${address} is not settled in its history and has no account. ${ARCHIVAL_RPC_NOTE}`,
    );
  }
  let claimedBy: string | null = null;
  let submitted: { deliverableHash: string; proofUri: string | null; submittedAt: number } | null =
    null;
  let disputed = false;
  for (const { event } of events) {
    if (event.name === "TaskClaimed") claimedBy = event.worker;
    if (event.name === "DeliverableSubmitted") submitted = event;
    if (event.name === "DisputeRaised") disputed = true;
  }
  return {
    source: "history",
    cluster,
    programId,
    state,
    disputed,
    figures: figures({
      address,
      buyer: create.buyer,
      worker: create.assignedWorker ?? claimedBy,
      taskId: create.taskId,
      amountMicro: create.amountUsdc,
      feeBps: create.feeBps,
      deadline: create.deadline,
      specHash: create.specHash,
      createdAt: create.createdAt,
      deliverableHash: submitted?.deliverableHash ?? null,
      proofUri: submitted?.proofUri ?? null,
      submittedAt: submitted?.submittedAt ?? null,
    }),
    settlement,
    signatures: lifecycle.map((t) => t.signature),
  };
}

/**
 * What the program recorded for one escrow, read from `options.rpc` alone. An open escrow reads
 * from its account and makes no history call; a closed one is rebuilt from the program's events
 * in the address's history, its newest lifecycle only. Throws {@link ChainReadError}.
 */
export async function readEscrowFromChain(
  target: ChainReadTarget,
  options: ReadEscrowFromChainOptions,
): Promise<ChainEscrowReading> {
  const maxTransactions = options.maxTransactions ?? CHAIN_READ_MAX_TRANSACTIONS;
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1) {
    throw invalidInput("maxTransactions must be a positive integer");
  }
  const id = getProgramId(options.cluster);
  assertProgramIdNotPlaceholder(id, options.cluster);
  const programId = new PublicKey(id);
  const address = resolveTarget(target, programId);
  const rpc = options.rpc;
  const account = await call("getAccountInfo", () =>
    rpc.getAccountInfo(address, { commitment: "confirmed" }),
  );
  // Anyone can send lamports to a closed escrow's address; the System-owned, empty account that
  // leaves is no escrow, and the escrow's record is its history.
  const closedButFunded =
    account !== null && account.owner.equals(SystemProgram.programId) && account.data.length === 0;
  if (account !== null && !closedButFunded) {
    return readAccount(address, account.owner, account.data, programId, options.cluster);
  }
  const lifecycle = await readLifecycle(rpc, address, id, maxTransactions);
  return readHistory(lifecycle, address.toBase58(), id, options.cluster);
}
