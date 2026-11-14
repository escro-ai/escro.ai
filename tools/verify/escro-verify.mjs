#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 escro.ai
//
// escro-verify: reads what the Escro program recorded for one escrow from any Solana RPC you name,
// with no Escro package or service in the path. An open escrow is read from its account; a closed
// one (every settlement closes the account) is rebuilt from the program's events in the address's
// transaction history, which it reads in legacy, version-0 and version-1 transactions. Nothing
// signs, nothing writes: the only RPC methods called are getAccountInfo, getSignaturesForAddress
// and getTransaction.
//
//   npm i @solana/web3.js@1
//   node escro-verify.mjs --cluster devnet|mainnet --rpc <url> (--address <pda> | --buyer <pubkey> --task-id <id>)
//
// stdout: one JSON document (amounts in micro-USDC as decimal strings, every character outside
// printable ASCII escaped). Exit 0 with a reading; 1 on usage or invalid input; 2 when the escrow
// is not reachable on this RPC (no account, or a history that does not reach its creation); 3 on
// any other failure. The --rpc URL is never printed.
//
// The program ids, the account version and layout and the event layouts below mirror the Escro
// program (its IDL); this file reads accounts at that version only, so a program upgrade that
// changes the account layout needs a newer copy of this file.
import { Connection, PublicKey, SolanaJSONRPCErrorCode, SystemProgram } from "@solana/web3.js";
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const PROGRAM_ID_DEVNET = "EjLpJ3obUYk1f2KDensU7UdGBZTxSdxufm7CSnMA3H5C";
export const PROGRAM_ID_MAINNET = "4CwLNRF4mFXutiBGjtMHQBxh8whW8T8EyvJXdRhY1rvr";
export const CURRENT_ACCOUNT_VERSION = 1;

export const ARCHIVAL_RPC_NOTE =
  "A settled escrow is closed on chain and survives only in transaction history; if it is older than this RPC's history, read it through an archival RPC.";

/** The `maxSupportedTransactionVersion` the history read asks. */
export const MAX_SUPPORTED_TRANSACTION_VERSION = 1;

/** getTransaction calls per read. */
export const MAX_TRANSACTIONS = 50;
/** getSignaturesForAddress pages per read, of SIGNATURE_PAGE signatures each. */
export const MAX_SIGNATURE_PAGES = 5;
const SIGNATURE_PAGE = 1000;
const MAX_TASK_ID_BYTES = 32;

export const ESCROW_ACCOUNT_DISCRIMINATOR = [36, 69, 48, 18, 128, 225, 125, 135];
export const ESCROW_ACCOUNT_SIZE = 537;

/** @typedef {"pubkey" | "u8" | "u16" | "u64" | "i64" | "string" | "option<pubkey>" | "option<string>" | "option<i64>" | "enum"} AccountKind */

/** @type {readonly { name: string, kind: AccountKind }[]} */
export const ESCROW_ACCOUNT_LAYOUT = [
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

/**
 * The account's EscrowState variants in discriminant order, and the state each reads as.
 * @type {readonly [string, string][]}
 */
const STATES = [
  ["Created", "CREATED"],
  ["Funded", "FUNDED"],
  ["InProgress", "IN_PROGRESS"],
  ["Submitted", "SUBMITTED"],
  ["Completed", "COMPLETED"],
  ["Disputed", "DISPUTED"],
  ["Refunded", "REFUNDED"],
];

/** @typedef {"pubkey" | "string" | "u64" | "i64" | "u16" | "bool" | { option: "pubkey" | "string" }} EventType */
/** @typedef {{ discriminator: number[], fields: [string, EventType][] }} EventLayout */

/** Each event's discriminator and Borsh fields, in IDL order with IDL names and types. */
/** @type {Record<string, EventLayout>} */
export const ESCRO_EVENT_LAYOUTS = {
  EscrowCreated: {
    discriminator: [70, 127, 105, 102, 92, 97, 7, 173],
    fields: [
      ["escrow", "pubkey"],
      ["buyer", "pubkey"],
      ["task_id", "string"],
      ["amount_usdc", "u64"],
      ["fee_bps", "u16"],
      ["deadline", "i64"],
      ["spec_hash", "string"],
      ["created_at", "i64"],
      ["assigned_worker", { option: "pubkey" }],
      ["marketplace_id", { option: "string" }],
      ["referrer_wallet", { option: "pubkey" }],
      ["referrer_bps", "u16"],
    ],
  },
  TaskClaimed: {
    discriminator: [208, 90, 243, 116, 80, 15, 228, 202],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["worker", "pubkey"],
      ["claimed_at", "i64"],
      ["assigned_at_creation", "bool"],
      ["marketplace_id", { option: "string" }],
    ],
  },
  DeliverableSubmitted: {
    discriminator: [128, 198, 110, 44, 67, 73, 255, 99],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["worker", "pubkey"],
      ["deliverable_hash", "string"],
      ["proof_uri", { option: "string" }],
      ["submitted_at", "i64"],
    ],
  },
  DisputeRaised: {
    discriminator: [246, 167, 109, 37, 142, 45, 38, 176],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["disputant", "pubkey"],
      ["reason", "string"],
      ["raised_at", "i64"],
    ],
  },
  EscrowCancelled: {
    discriminator: [98, 241, 195, 122, 213, 0, 162, 161],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["buyer", "pubkey"],
      ["refund_amount", "u64"],
      ["marketplace_id", { option: "string" }],
      ["cancelled_at", "i64"],
    ],
  },
  PaymentReleased: {
    discriminator: [160, 132, 155, 232, 46, 254, 69, 219],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["worker", "pubkey"],
      ["worker_amount", "u64"],
      ["fee_amount", "u64"],
      ["referrer_amount", "u64"],
      ["referrer", { option: "pubkey" }],
      ["marketplace_id", { option: "string" }],
      ["resolved_at", "i64"],
    ],
  },
  BuyerRefunded: {
    discriminator: [146, 238, 116, 115, 63, 254, 107, 176],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["buyer", "pubkey"],
      ["refund_amount", "u64"],
      ["marketplace_id", { option: "string" }],
      ["resolved_at", "i64"],
    ],
  },
};

/** A read that gave no reading; `reason` names the failed account check. */
export class ChainReadError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ reason?: string, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "ChainReadError";
    this.code = code;
    this.reason = options.reason;
  }
}

// ── Borsh ─────────────────────────────────────────────────────────────────────

/** @typedef {string | number | bigint | boolean | null} Value */

class Reader {
  /**
   * @param {Uint8Array} data
   * @param {(detail: string) => Error} fail
   */
  constructor(data, fail) {
    this.data = data;
    this.fail = fail;
    this.at = 0;
  }

  /** @param {number} n */
  take(n) {
    if (this.at + n > this.data.length) throw this.fail("a field reads past the content");
    const bytes = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return bytes;
  }

  /** @param {number} n */
  view(n) {
    const bytes = this.take(n);
    return new DataView(bytes.buffer, bytes.byteOffset, n);
  }

  /** @returns {Value} */
  read(/** @type {string} */ type) {
    switch (type) {
      case "pubkey":
        return new PublicKey(this.take(32)).toBase58();
      case "string": {
        const length = this.view(4).getUint32(0, true);
        const bytes = this.take(length);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw this.fail("a string field is not UTF-8");
        }
      }
      case "u8":
        return this.view(1).getUint8(0);
      case "u16":
        return this.view(2).getUint16(0, true);
      case "u64":
        return this.view(8).getBigUint64(0, true);
      case "i64": {
        const value = this.view(8).getBigInt64(0, true);
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw this.fail("an i64 field is outside the safe integer range");
        }
        return Number(value);
      }
      case "bool": {
        const byte = this.view(1).getUint8(0);
        if (byte > 1) throw this.fail(`a bool byte is ${String(byte)}`);
        return byte === 1;
      }
    }
    throw this.fail(`no reader for ${type}`);
  }

  /** @param {string} inner */
  option(inner) {
    const tag = this.view(1).getUint8(0);
    if (tag === 0) return null;
    if (tag !== 1) throw this.fail(`an option tag is ${String(tag)}`);
    return this.read(inner);
  }
}

// ── The account ───────────────────────────────────────────────────────────────

/**
 * The account's fields by IDL name, or a throw from `refuse(reason, detail)`. Checks run in order:
 * discriminator, version, layout.
 * @param {Uint8Array} data
 * @param {(reason: string, detail: string) => Error} refuse
 * @returns {Record<string, Value>}
 */
function decodeAccount(data, refuse) {
  if (
    data.length < ESCROW_ACCOUNT_DISCRIMINATOR.length ||
    ESCROW_ACCOUNT_DISCRIMINATOR.some((byte, i) => data[i] !== byte)
  ) {
    throw refuse("discriminator", "its discriminator is not EscrowAccount's");
  }
  const version = data[ESCROW_ACCOUNT_DISCRIMINATOR.length];
  if (version !== undefined && version !== CURRENT_ACCOUNT_VERSION) {
    throw refuse(
      "version",
      `its version is ${String(version)}; this reader reads version ${String(CURRENT_ACCOUNT_VERSION)}`,
    );
  }
  if (data.length !== ESCROW_ACCOUNT_SIZE) {
    throw refuse(
      "layout",
      `it is ${String(data.length)} bytes; an EscrowAccount is ${String(ESCROW_ACCOUNT_SIZE)}`,
    );
  }
  const reader = new Reader(data, (detail) => refuse("layout", detail));
  reader.take(ESCROW_ACCOUNT_DISCRIMINATOR.length);
  /** @type {Record<string, Value>} */
  const decoded = {};
  for (const { name, kind } of ESCROW_ACCOUNT_LAYOUT) {
    if (kind === "enum") {
      const index = Number(reader.read("u8"));
      const state = STATES[index];
      if (state === undefined)
        throw refuse("layout", `state ${String(index)} is no EscrowState variant`);
      decoded[name] = state[1];
    } else if (kind.startsWith("option<")) {
      decoded[name] = reader.option(kind.slice("option<".length, -1));
    } else {
      decoded[name] = reader.read(kind);
    }
  }
  return decoded;
}

/** @param {bigint} amount @param {number} feeBps */
const escrowFee = (amount, feeBps) => (amount * BigInt(feeBps)) / 10_000n;

/**
 * @param {{ address: string, buyer: string, worker: string | null, taskId: string, amountMicro: bigint, feeBps: number, deadline: number, specHash: string, createdAt: number, deliverableHash: string | null, proofUri: string | null, submittedAt: number | null }} base
 */
function figures(base) {
  const feeMicro = escrowFee(base.amountMicro, base.feeBps);
  return { ...base, feeMicro, depositMicro: base.amountMicro + feeMicro };
}

/** @param {PublicKey} programId @param {PublicKey} buyer @param {string} taskId */
function deriveEscrowPda(programId, buyer, taskId) {
  const utf8 = new TextEncoder();
  return PublicKey.findProgramAddressSync(
    [utf8.encode("escrow"), buyer.toBytes(), utf8.encode(taskId)],
    programId,
  )[0];
}

/**
 * @param {PublicKey} address
 * @param {PublicKey} owner
 * @param {Uint8Array} data
 * @param {PublicKey} programId
 * @param {string} cluster
 */
function readAccount(address, owner, data, programId, cluster) {
  const at = address.toBase58();
  /** @param {string} reason @param {string} detail */
  const refuse = (reason, detail) =>
    new ChainReadError(
      "CHAIN_ACCOUNT_INVALID",
      `The account at ${at} is not a current EscrowAccount: ${detail}`,
      { reason },
    );
  if (!owner.equals(programId)) {
    throw refuse(
      "owner",
      `it is owned by ${owner.toBase58()}, not the program ${programId.toBase58()}`,
    );
  }
  const d = decodeAccount(data, refuse);
  const buyer = String(d.buyer);
  const taskId = String(d.task_id);
  const derived =
    new TextEncoder().encode(taskId).length <= MAX_TASK_ID_BYTES
      ? deriveEscrowPda(programId, new PublicKey(buyer), taskId)
      : null;
  if (!derived?.equals(address)) {
    throw refuse("pda", "its buyer and task id do not derive this address");
  }
  const optional = (/** @type {Value | undefined} */ v) =>
    v === null || v === undefined ? null : v;
  return {
    source: "account",
    cluster,
    programId: programId.toBase58(),
    state: d.state,
    disputed: d.state === "DISPUTED",
    figures: figures({
      address: at,
      buyer,
      worker: /** @type {string | null} */ (optional(d.assigned_worker)),
      taskId,
      amountMicro: /** @type {bigint} */ (d.amount_usdc),
      feeBps: Number(d.fee_bps),
      deadline: Number(d.deadline),
      specHash: String(d.spec_hash),
      createdAt: Number(d.created_at),
      deliverableHash: /** @type {string | null} */ (optional(d.deliverable_hash)),
      proofUri: /** @type {string | null} */ (optional(d.proof_uri)),
      submittedAt: /** @type {number | null} */ (optional(d.submitted_at)),
    }),
    settlement: null,
    signatures: [],
  };
}

// ── Transaction versions ──────────────────────────────────────────────────────

// web3 1.98's response struct accepts only "legacy" and 0, while a version-1 message names static
// account keys only, the legacy message shape; so the read asks the RPC for version 1 and its
// Connection's fetch presents an ok version-1 getTransaction result as legacy. A version-1 result
// naming an address lookup or a loaded address keeps its version and web3 refuses it: the read
// stops at a transaction it cannot read rather than read it differently from the chain.

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The parsed JSON of `text`, or undefined when it is not JSON (the caller passes it on as is). */
function parsedJson(/** @type {string} */ text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @param {unknown} body */
function isSingleGetTransaction(body) {
  if (typeof body !== "string") return false;
  const request = parsedJson(body);
  return isObject(request) && request.method === "getTransaction";
}

/** @param {unknown} value */
const isEmptyList = (value) => Array.isArray(value) && value.length === 0;

/**
 * Whether `result` is a version-1 transaction whose message names only static account keys.
 * @param {unknown} result
 * @returns {result is Record<string, unknown>}
 */
function isStaticVersionOne(result) {
  if (!isObject(result) || result.version !== 1) return false;
  const transaction = result.transaction;
  const message = isObject(transaction) ? transaction.message : undefined;
  const lookups = isObject(message) ? message.addressTableLookups : undefined;
  if (lookups !== undefined && !isEmptyList(lookups)) return false;
  const meta = result.meta;
  if (meta === null) return true;
  if (!isObject(meta)) return false;
  const loaded = meta.loadedAddresses;
  if (loaded === undefined) return true;
  return isObject(loaded) && isEmptyList(loaded.writable) && isEmptyList(loaded.readonly);
}

/**
 * `fetchFn` with an ok `getTransaction` result of version 1 that names no address lookup and no
 * loaded address presented as `"legacy"`, nothing else of it changed. Every other request and
 * every non-ok response is `fetchFn`'s own `Response`; any other ok `getTransaction` response is
 * returned unchanged. One `fetchFn` call per call; its rejection propagates as is.
 * @param {typeof globalThis.fetch} fetchFn
 * @returns {typeof globalThis.fetch}
 */
export function transactionVersionFetch(fetchFn) {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (!response.ok || !isSingleGetTransaction(init?.body)) return response;
    const parsed = parsedJson(await response.clone().text());
    if (!isObject(parsed) || !isStaticVersionOne(parsed.result)) return response;
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);
    return new Response(
      JSON.stringify({ ...parsed, result: { ...parsed.result, version: "legacy" } }),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  };
}

// ── The history ───────────────────────────────────────────────────────────────

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const EXIT = /^Program (\w+) (?:success|failed)/;
const DATA = "Program data: ";
const TRUNCATED = "Log truncated";

/**
 * The payload of every `Program data:` line logged while one of `programId`'s frames is innermost,
 * in log order; a line under any other program's frame, at any depth, is not one.
 * @param {readonly string[]} logs
 * @param {string} programId
 * @param {(detail: string) => Error} unreadable
 */
function programData(logs, programId, unreadable) {
  /** @type {string[]} */
  const stack = [];
  /** @type {string[]} */
  const payloads = [];
  for (const line of logs) {
    if (line === TRUNCATED) throw unreadable("has truncated logs");
    const invoke = INVOKE.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1)
        throw unreadable("has logs whose frames do not nest");
      stack.push(invoke[1] ?? "");
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit) {
      if (stack.pop() !== exit[1]) throw unreadable("has logs whose frames do not nest");
      continue;
    }
    if (line.startsWith(DATA) && stack.at(-1) === programId) payloads.push(line.slice(DATA.length));
  }
  return payloads;
}

/**
 * One event payload: its name and fields by IDL name; null when no event's discriminator opens it.
 * @param {Uint8Array} data
 * @returns {{ name: string, fields: Record<string, Value> } | null}
 */
function decodeEvent(data) {
  const name = Object.keys(ESCRO_EVENT_LAYOUTS).find((n) =>
    ESCRO_EVENT_LAYOUTS[n]?.discriminator.every((byte, i) => data[i] === byte),
  );
  const layout = name === undefined ? undefined : ESCRO_EVENT_LAYOUTS[name];
  if (name === undefined || layout === undefined) return null;
  const reader = new Reader(data.subarray(8), (detail) => new Error(detail));
  /** @type {Record<string, Value>} */
  const fields = {};
  for (const [field, type] of layout.fields) {
    fields[field] = typeof type === "string" ? reader.read(type) : reader.option(type.option);
  }
  if (reader.at !== reader.data.length) throw new Error("trailing bytes");
  return { name, fields };
}

/**
 * The program's events for `address` in one transaction's logs, in log order.
 * @param {readonly string[]} logs
 * @param {string} programId
 * @param {string} address
 * @param {string} signature
 */
function eventsFor(logs, programId, address, signature) {
  /** @param {string} detail */
  const unreadable = (detail) =>
    new ChainReadError(
      "CHAIN_LOGS_TRUNCATED",
      `Transaction ${signature} in the history of ${address} ${detail}; its events cannot be read`,
    );
  const events = [];
  for (const payload of programData(logs, programId, unreadable)) {
    let event;
    try {
      event = decodeEvent(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    } catch {
      throw unreadable("logs an event that does not decode");
    }
    if (event !== null && event.fields.escrow === address) events.push(event);
  }
  return events;
}

/**
 * @template T
 * @param {string} method
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function call(method, run) {
  try {
    return await run();
  } catch (cause) {
    throw rpcFailed(method, cause);
  }
}

/**
 * @param {string} method
 * @param {unknown} cause
 */
function rpcFailed(method, cause) {
  const note = method === "getAccountInfo" ? "" : ` ${ARCHIVAL_RPC_NOTE}`;
  return new ChainReadError("CHAIN_RPC_FAILED", `The RPC's ${method} call failed.${note}`, {
    cause,
  });
}

/**
 * Whether the RPC refused a transaction above the version the read asked.
 * @param {unknown} cause
 */
const isVersionRefusal = (cause) =>
  isObject(cause) &&
  cause.code === SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION;

/**
 * Transaction `signature` in the history of `at`, at every version the read reads.
 * @param {Connection} rpc
 * @param {string} signature
 * @param {string} at
 */
async function readTransaction(rpc, signature, at) {
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

/**
 * The newest lifecycle at `address`: the listing newest first (block order, never re-sorted),
 * failed entries skipped unfetched, back to the transaction holding the newest EscrowCreated.
 * @param {Connection} rpc
 * @param {PublicKey} address
 * @param {string} programId
 */
async function readLifecycle(rpc, address, programId) {
  const at = address.toBase58();
  /** @type {{ signature: string, events: { name: string, fields: Record<string, Value> }[] }[]} */
  const newestFirst = [];
  let pages = 0;
  let fetched = 0;
  let listed = false;
  /** @type {string | undefined} */
  let before;
  for (;;) {
    if (pages === MAX_SIGNATURE_PAGES) {
      throw new ChainReadError(
        "CHAIN_HISTORY_BUDGET",
        `Reading the history of ${at} needs more than ${String(MAX_SIGNATURE_PAGES)} pages of ${String(SIGNATURE_PAGE)} signatures`,
      );
    }
    const options =
      before === undefined ? { limit: SIGNATURE_PAGE } : { limit: SIGNATURE_PAGE, before };
    const page = await call("getSignaturesForAddress", () =>
      rpc.getSignaturesForAddress(address, options, "confirmed"),
    );
    pages += 1;
    if (page.length > 0) listed = true;
    for (const entry of page) {
      if (entry.err !== null) continue;
      if (fetched === MAX_TRANSACTIONS) {
        throw new ChainReadError(
          "CHAIN_HISTORY_BUDGET",
          `Reading the history of ${at} needs more than ${String(MAX_TRANSACTIONS)} transactions`,
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
      const withoutLogs = new ChainReadError(
        "CHAIN_HISTORY_INCOMPLETE",
        `This RPC serves transaction ${entry.signature} in the history of ${at} without its logs. ${ARCHIVAL_RPC_NOTE}`,
      );
      if (tx.meta === null) throw withoutLogs;
      if (tx.meta.err !== null) continue;
      const logs = tx.meta.logMessages;
      if (logs === null || logs === undefined) throw withoutLogs;
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

/**
 * @param {{ signature: string, events: { name: string, fields: Record<string, Value> }[] }[]} lifecycle
 * @param {string} address
 * @param {string} programId
 * @param {string} cluster
 */
function readHistory(lifecycle, address, programId, cluster) {
  const events = lifecycle.flatMap((t) =>
    t.events.map((event) => ({ ...event, signature: t.signature })),
  );
  const create = events[0];
  const last = events.at(-1);
  if (create?.name !== "EscrowCreated" || last === undefined) {
    throw new Error("the lifecycle does not open with EscrowCreated");
  }
  const f = last.fields;
  let state;
  let settlement;
  if (last.name === "PaymentReleased") {
    state = "COMPLETED";
    settlement = {
      kind: "released",
      workerAmountMicro: f.worker_amount,
      feeAmountMicro: f.fee_amount,
      refundAmountMicro: null,
      resolvedAt: f.resolved_at,
      signature: last.signature,
    };
  } else if (last.name === "BuyerRefunded" || last.name === "EscrowCancelled") {
    const cancelled = last.name === "EscrowCancelled";
    state = cancelled ? "CANCELLED" : "REFUNDED";
    settlement = {
      kind: cancelled ? "cancelled" : "refunded",
      workerAmountMicro: null,
      feeAmountMicro: null,
      refundAmountMicro: f.refund_amount,
      resolvedAt: cancelled ? f.cancelled_at : f.resolved_at,
      signature: last.signature,
    };
  } else {
    throw new ChainReadError(
      "CHAIN_HISTORY_INCOMPLETE",
      `The latest lifecycle at ${address} is not settled in its history and has no account. ${ARCHIVAL_RPC_NOTE}`,
    );
  }
  /** @type {string | null} */
  let claimedBy = null;
  /** @type {Record<string, Value> | null} */
  let submitted = null;
  let disputed = false;
  for (const event of events) {
    if (event.name === "TaskClaimed") claimedBy = String(event.fields.worker);
    if (event.name === "DeliverableSubmitted") submitted = event.fields;
    if (event.name === "DisputeRaised") disputed = true;
  }
  const c = create.fields;
  return {
    source: "history",
    cluster,
    programId,
    state,
    disputed,
    figures: figures({
      address,
      buyer: String(c.buyer),
      worker: c.assigned_worker === null ? claimedBy : String(c.assigned_worker),
      taskId: String(c.task_id),
      amountMicro: /** @type {bigint} */ (c.amount_usdc),
      feeBps: Number(c.fee_bps),
      deadline: Number(c.deadline),
      specHash: String(c.spec_hash),
      createdAt: Number(c.created_at),
      deliverableHash: submitted === null ? null : String(submitted.deliverable_hash),
      proofUri:
        submitted === null || submitted.proof_uri === null ? null : String(submitted.proof_uri),
      submittedAt: submitted === null ? null : Number(submitted.submitted_at),
    }),
    settlement,
    signatures: lifecycle.map((t) => t.signature),
  };
}

// ── The read ──────────────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {string} what
 */
function parsedKey(value, what) {
  /** @type {PublicKey | null} */
  let key = null;
  if (typeof value === "string") {
    try {
      key = new PublicKey(value);
    } catch {
      key = null;
    }
  }
  if (key === null || key.toBase58() !== value) {
    throw new ChainReadError("INVALID_INPUT", `The ${what} is not a base58 public key`);
  }
  return key;
}

/**
 * What the program recorded for one escrow, read from `rpc` alone.
 * @param {{ address: string } | { buyer: string, taskId: string }} target
 * @param {{ cluster: "devnet" | "mainnet", rpc: Connection }} options
 */
export async function readEscrow(target, options) {
  const id = options.cluster === "mainnet" ? PROGRAM_ID_MAINNET : PROGRAM_ID_DEVNET;
  const programId = new PublicKey(id);
  let address;
  if ("address" in target) {
    address = parsedKey(target.address, "address");
  } else {
    const buyer = parsedKey(target.buyer, "buyer");
    const bytes = new TextEncoder().encode(target.taskId).length;
    if (bytes > MAX_TASK_ID_BYTES) {
      throw new ChainReadError(
        "INVALID_INPUT",
        `The task id is ${String(bytes)} bytes in UTF-8; an escrow's task id is at most ${String(MAX_TASK_ID_BYTES)}`,
      );
    }
    address = deriveEscrowPda(programId, buyer, target.taskId);
  }
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
  const lifecycle = await readLifecycle(rpc, address, id);
  return readHistory(lifecycle, address.toBase58(), id, options.cluster);
}

// ── The command line ──────────────────────────────────────────────────────────

const USAGE =
  "usage: node escro-verify.mjs --cluster devnet|mainnet --rpc <url> (--address <pda> | --buyer <pubkey> --task-id <id>)";

/** JSON with bigints as decimal strings and every character outside printable ASCII escaped. */
export function asciiJson(/** @type {unknown} */ value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** @param {string} text */
const asciiText = (text) =>
  text.replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** @param {string} code */
function exitFor(code) {
  if (code === "INVALID_INPUT") return 1;
  if (code === "CHAIN_ESCROW_NOT_FOUND" || code === "CHAIN_HISTORY_INCOMPLETE") return 2;
  return 3;
}

/**
 * Run with `args`; resolves with the exit code. Nothing written names the --rpc URL: an RPC failure
 * prints the reader's fixed message, never the transport's own error.
 * @param {string[]} args
 */
export async function main(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        cluster: { type: "string" },
        rpc: { type: "string" },
        address: { type: "string" },
        buyer: { type: "string" },
        "task-id": { type: "string" },
      },
    }).values;
  } catch {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const { cluster, rpc: rpcUrl, address, buyer } = parsed;
  const taskId = parsed["task-id"];
  const byAddress = address !== undefined;
  const byTask = buyer !== undefined && taskId !== undefined;
  const partTask = buyer !== undefined || taskId !== undefined;
  if (
    (cluster !== "devnet" && cluster !== "mainnet") ||
    rpcUrl === undefined ||
    byAddress === partTask ||
    (partTask && !byTask)
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  let rpc;
  try {
    rpc = new Connection(rpcUrl, {
      commitment: "confirmed",
      fetch: transactionVersionFetch(globalThis.fetch),
    });
  } catch {
    process.stderr.write(`--rpc must be an http: or https: URL\n${USAGE}\n`);
    return 1;
  }
  const target =
    address !== undefined ? { address } : { buyer: String(buyer), taskId: String(taskId) };
  try {
    const reading = await readEscrow(target, { cluster, rpc });
    process.stdout.write(`${asciiJson(reading)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ChainReadError) {
      process.stderr.write(`${asciiText(`${err.code}: ${err.message}`)}\n`);
      return exitFor(err.code);
    }
    process.stderr.write("UNEXPECTED: the read failed outside the verifier's checks\n");
    return 3;
  }
}

function invokedDirectly() {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
