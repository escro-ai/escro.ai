// The worker's check of a presented `on-delivery` payload, over RPC alone
// (docs/specs/scheme_on_delivery_svm.md, "Server, per paid request"), against requirements the
// server derives itself and never against the payment's `accepted`.
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import {
  clusterOfCaip2,
  getProgramId,
  isRecord,
  type OnDeliveryAccept,
  type OnDeliveryPayloadFields,
  type PaymentPayload,
} from "@escro/shared";
import { deriveEscrowPda, isCanonicalPubkey } from "@escro/shared/solana";

import { ChainReadError, decodeEscrowAccount, type DecodedEscrowAccount } from "../chain-read.js";
import { EscroError } from "../errors.js";
import { amountOf, isOnDeliveryScheme, isSpecHash } from "./accept.js";
import { buyerMessage, isAbsoluteHttpUrl, isSignedAt } from "./buyer-signature.js";
import { hasMembers } from "./extension.js";

/**
 * The record of accepted presentations a server keeps; one per server, never module state.
 */
export interface ReplayStore {
  /**
   * Records `key` until `expiresAtMs` (inclusive) and returns true; returns false when `key` is held and unexpired at
   * `nowMs`. Atomic per key (a shared store: Redis `SET NX PX`, Postgres `INSERT ... ON CONFLICT DO NOTHING`). A claim
   * is spent before the account read: a presentation that fails a later step is re-signed.
   */
  claim(key: string, expiresAtMs: number, nowMs: number): boolean | Promise<boolean>;
}

/**
 * An in-memory {@link ReplayStore}: one map per call, held by this process only, so it suits a
 * single-process server; servers behind a load balancer share a store. Each claim drops the keys
 * expired at its `nowMs`. `size` is the number of keys held.
 */
export function memoryReplayStore(): ReplayStore & { readonly size: number } {
  const held = new Map<string, number>();
  return {
    claim(key: string, expiresAtMs: number, nowMs: number): boolean {
      for (const [stale, expiry] of held) {
        if (expiry < nowMs) held.delete(stale);
      }
      if (held.has(key)) return false;
      held.set(key, expiresAtMs);
      return true;
    },
    get size(): number {
      return held.size;
    },
  };
}

/** The binding's error-code table, in its order. */
export const ON_DELIVERY_SVM_INVALID_REASONS = [
  "invalid_on_delivery_svm_payload",
  "invalid_on_delivery_svm_escrow_address_mismatch",
  "invalid_on_delivery_svm_buyer_signature",
  "invalid_on_delivery_svm_signature_expired",
  "invalid_on_delivery_svm_escrow_not_found",
  "invalid_on_delivery_svm_escrow_owner",
  "invalid_on_delivery_svm_escrow_version",
  "invalid_on_delivery_svm_wrong_state",
  "invalid_on_delivery_svm_buyer_mismatch",
  "invalid_on_delivery_svm_worker_mismatch",
  "invalid_on_delivery_svm_amount_mismatch",
  "invalid_on_delivery_svm_spec_hash_mismatch",
  "invalid_on_delivery_svm_deadline",
  "invalid_on_delivery_svm_claim_failed",
] as const;

export type OnDeliveryInvalidReason =
  | (typeof ON_DELIVERY_SVM_INVALID_REASONS)[number]
  | "invalid_x402_version"
  | "invalid_scheme"
  | "invalid_network"
  | "invalid_payment_requirements";

export interface VerifyPresentationContext {
  /** The absolute URL this server is serving: the paid route, or the poll URL for a poll. */
  resourceUrl: string;
  replay: ReplayStore;
  /** Unix milliseconds. */
  now?: () => number;
}

export interface VerifyEscrowContext extends VerifyPresentationContext {
  rpc: Pick<Connection, "getAccountInfo">;
}

export type BuyerPresentationResult =
  | { isValid: true; payer: string }
  | { isValid: false; invalidReason: OnDeliveryInvalidReason };

/** `payer` is set on an invalid verdict exactly when the buyer's signature verified. */
export type OnDeliveryVerifyResult =
  | { isValid: true; payer: string; job: "new" | "retry"; escrow: DecodedEscrowAccount }
  | { isValid: false; invalidReason: OnDeliveryInvalidReason; payer?: string };

const WINDOW_MS = 30_000;
const MAX_TASK_ID_BYTES = 32;
// The longest base58 text of 32 and of 64 bytes. Base58 decoding is quadratic in the text's
// length, so longer text is refused before it is decoded.
const MAX_KEY_CHARS = 44;
const MAX_SIGNATURE_CHARS = 88;
const PAYLOAD_FIELDS = [
  "escrow",
  "buyer",
  "taskId",
  "createSignature",
  "signedAt",
  "buyerSignature",
];
/** RFC 8032's group order: a signature's S must be below it (section 5.1.7). */
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

const refused = (
  invalidReason: OnDeliveryInvalidReason,
): { isValid: false; invalidReason: OnDeliveryInvalidReason } => ({
  isValid: false,
  invalidReason,
});

function isSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_SIGNATURE_CHARS) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

/** S, bytes 32 to 63 little-endian, is below L. */
function canonicalS(signature: Uint8Array): boolean {
  let s = 0n;
  for (let i = 63; i >= 32; i -= 1) s = (s << 8n) | BigInt(signature[i] ?? 0);
  return s < ED25519_L;
}

/** The server's own entry is one it can verify against: its program is the one pinned for its network. */
function wellFormedEntry(entry: unknown): boolean {
  if (!isRecord(entry) || !isOnDeliveryScheme(entry.scheme) || typeof entry.network !== "string") {
    return false;
  }
  const cluster = clusterOfCaip2(entry.network);
  const extra = entry.extra;
  return (
    cluster !== undefined &&
    isRecord(extra) &&
    extra.program === getProgramId(cluster) &&
    typeof entry.payTo === "string" &&
    isCanonicalPubkey(entry.payTo) &&
    amountOf(entry.amount) !== undefined &&
    isSpecHash(extra.specHash) &&
    typeof extra.deadline === "number" &&
    Number.isSafeInteger(extra.deadline)
  );
}

const isKeyText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_KEY_CHARS && isCanonicalPubkey(value);

/** The six payload fields, each well formed (binding server step 1); undefined otherwise. */
function payloadFields(payload: unknown): OnDeliveryPayloadFields | undefined {
  if (!hasMembers(payload, PAYLOAD_FIELDS)) return undefined;
  const { escrow, buyer, taskId, createSignature, signedAt, buyerSignature } = payload;
  if (!isKeyText(escrow) || !isKeyText(buyer)) return undefined;
  if (typeof taskId !== "string" || new TextEncoder().encode(taskId).length > MAX_TASK_ID_BYTES) {
    return undefined;
  }
  if (!isSignature(createSignature) || !isSignature(buyerSignature) || !isSignedAt(signedAt)) {
    return undefined;
  }
  return { escrow, buyer, taskId, createSignature, signedAt, buyerSignature };
}

function requireContext(ctx: unknown): void {
  const replay = isRecord(ctx) ? ctx.replay : undefined;
  if (!isRecord(replay) || typeof replay.claim !== "function") {
    throw new EscroError(
      "Verification needs ctx.replay: the ReplayStore that records each accepted presentation",
      "VALIDATION_ERROR",
    );
  }
  const resourceUrl = isRecord(ctx) ? ctx.resourceUrl : undefined;
  if (typeof resourceUrl !== "string" || !isAbsoluteHttpUrl(resourceUrl)) {
    throw new EscroError(
      "Verification needs ctx.resourceUrl: the absolute http: or https: URL being served",
      "VALIDATION_ERROR",
    );
  }
}

/** Binding server steps 1 to 3, after the requirement and core checks. */
async function presentation(
  payment: PaymentPayload,
  entry: OnDeliveryAccept,
  ctx: VerifyPresentationContext,
): Promise<
  { fields: OnDeliveryPayloadFields } | { isValid: false; invalidReason: OnDeliveryInvalidReason }
> {
  requireContext(ctx);
  if (!wellFormedEntry(entry)) return refused("invalid_payment_requirements");
  const presented: unknown = payment;
  if (!isRecord(presented) || presented.x402Version !== 2) return refused("invalid_x402_version");
  const accepted = presented.accepted;
  if (!isRecord(accepted) || !isOnDeliveryScheme(accepted.scheme)) return refused("invalid_scheme");
  if (accepted.network !== entry.network) return refused("invalid_network");
  const fields = payloadFields(presented.payload);
  if (fields === undefined) return refused("invalid_on_delivery_svm_payload");
  const program = new PublicKey(entry.extra.program);
  const pda = deriveEscrowPda(program, new PublicKey(fields.buyer), fields.taskId);
  if (pda.toBase58() !== fields.escrow) {
    return refused("invalid_on_delivery_svm_escrow_address_mismatch");
  }
  // One clock reading judges the window and the record.
  const nowMs = ctx.now?.() ?? Date.now();
  if (Math.abs(nowMs - fields.signedAt) > WINDOW_MS) {
    return refused("invalid_on_delivery_svm_signature_expired");
  }
  const message = buyerMessage(fields.signedAt, ctx.resourceUrl, fields.escrow);
  const signature = bs58.decode(fields.buyerSignature);
  const verified =
    canonicalS(signature) &&
    nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      signature,
      new PublicKey(fields.buyer).toBytes(),
    );
  if (!verified) return refused("invalid_on_delivery_svm_buyer_signature");
  const claimed = await ctx.replay.claim(
    `${fields.buyer}:${message}`,
    fields.signedAt + WINDOW_MS,
    nowMs,
  );
  if (!claimed) return refused("invalid_on_delivery_svm_buyer_signature");
  return { fields };
}

/**
 * Binding server steps 1 to 3, with no RPC call: what a poll runs, `ctx.resourceUrl` being the poll
 * URL. Throws {@link EscroError} `VALIDATION_ERROR` before any work when `ctx.replay` is missing or
 * `ctx.resourceUrl` is not an absolute http: or https: URL.
 */
export async function verifyBuyerPresentation(
  payment: PaymentPayload,
  entry: OnDeliveryAccept,
  ctx: VerifyPresentationContext,
): Promise<BuyerPresentationResult> {
  const result = await presentation(payment, entry, ctx);
  if ("isValid" in result) return result;
  return { isValid: true, payer: result.fields.buyer };
}

/**
 * Binding server steps 1 to 6 against the server's own `entry`: the payload, the escrow PDA, the
 * buyer's signature within 30 s, claimed once in `ctx.replay`, then the escrow account read at
 * `confirmed`. A Funded escrow is a new job; InProgress or Submitted a retry. Throws
 * {@link ChainReadError} `CHAIN_RPC_FAILED` when the RPC fails, and {@link EscroError}
 * `VALIDATION_ERROR` before any work when `ctx.replay` is missing or `ctx.resourceUrl` is not an
 * absolute http: or https: URL.
 */
export async function verifyEscrowPayload(
  payment: PaymentPayload,
  entry: OnDeliveryAccept,
  ctx: VerifyEscrowContext,
): Promise<OnDeliveryVerifyResult> {
  const result = await presentation(payment, entry, ctx);
  if ("isValid" in result) return result;
  const { fields } = result;
  const payer = fields.buyer;
  const invalid = (invalidReason: OnDeliveryInvalidReason): OnDeliveryVerifyResult => ({
    isValid: false,
    invalidReason,
    payer,
  });
  let account: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    account = await ctx.rpc.getAccountInfo(new PublicKey(fields.escrow), {
      commitment: "confirmed",
    });
  } catch (cause) {
    throw new ChainReadError("CHAIN_RPC_FAILED", "The RPC's getAccountInfo call failed.", {
      cause,
    });
  }
  if (
    account === null ||
    (account.owner.equals(SystemProgram.programId) && account.data.length === 0)
  ) {
    return invalid("invalid_on_delivery_svm_escrow_not_found");
  }
  if (account.owner.toBase58() !== entry.extra.program) {
    return invalid("invalid_on_delivery_svm_escrow_owner");
  }
  let escrow: DecodedEscrowAccount;
  try {
    escrow = decodeEscrowAccount(account.data);
  } catch (err) {
    if (!(err instanceof ChainReadError)) throw err;
    return invalid(
      err.reason === "version"
        ? "invalid_on_delivery_svm_escrow_version"
        : "invalid_on_delivery_svm_escrow_owner",
    );
  }
  const { buyer, assigned_worker, amount_usdc, spec_hash, deadline, state } = escrow;
  if (typeof buyer !== "string" || buyer !== fields.buyer) {
    return invalid("invalid_on_delivery_svm_buyer_mismatch");
  }
  if (typeof assigned_worker !== "string" || assigned_worker !== entry.payTo) {
    return invalid("invalid_on_delivery_svm_worker_mismatch");
  }
  if (typeof amount_usdc !== "bigint" || amount_usdc !== BigInt(entry.amount)) {
    return invalid("invalid_on_delivery_svm_amount_mismatch");
  }
  if (typeof spec_hash !== "string" || spec_hash !== entry.extra.specHash) {
    return invalid("invalid_on_delivery_svm_spec_hash_mismatch");
  }
  if (typeof deadline !== "number" || deadline < entry.extra.deadline) {
    return invalid("invalid_on_delivery_svm_deadline");
  }
  if (state === "Funded") return { isValid: true, payer, job: "new", escrow };
  if (state === "InProgress" || state === "Submitted") {
    return { isValid: true, payer, job: "retry", escrow };
  }
  return invalid("invalid_on_delivery_svm_wrong_state");
}
