// The buyer's side of an `on-delivery` 402 (docs/specs/scheme_on_delivery_svm.md, "Client, before
// funding"), and the worker's builder of the entry it advertises.
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  CURRENT_ACCOUNT_VERSION,
  MIN_ESCROW_AMOUNT,
  ONCHAIN_TIMEOUT_SECONDS,
  escrowFee,
  getCaip2Network,
  getPlatformConfigPda,
  getProgramId,
  getUsdcMint,
  isRecord,
  type Acceptance,
  type EscroExtensionInfo,
  type OnDeliveryAccept,
  type OnDeliveryScheme,
  type PaymentRequired,
  type PlatformConfigAccount,
  type ResourceInfo,
  type SettlementMode,
  type SolanaCluster,
} from "@escro/shared";
import { decodePlatformConfig, isCanonicalPubkey } from "@escro/shared/solana";

import { ChainReadError } from "../chain-read.js";
import { EscroError } from "../errors.js";
import {
  OnDeliveryAcceptError,
  PlatformConfigNotFoundError,
  type OnDeliveryAcceptRefusal,
} from "./errors.js";
import { hasMembers, isEscroExtensionInfo } from "./extension.js";

export type PlatformConfigTerms = Pick<PlatformConfigAccount, "usdcMint" | "feeBps">;

/**
 * The cluster's PlatformConfig, read at its PDA and decoded by the shared decoder. Throws
 * {@link PlatformConfigNotFoundError} when no account is there, and {@link ChainReadError}
 * `CHAIN_ACCOUNT_INVALID` (reason `version`) on a version this SDK does not read.
 */
export async function readPlatformConfig(
  rpc: Pick<Connection, "getAccountInfo">,
  cluster: SolanaCluster,
): Promise<PlatformConfigTerms & { treasury: string }> {
  const address = getPlatformConfigPda(cluster);
  let account: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    account = await rpc.getAccountInfo(new PublicKey(address), { commitment: "confirmed" });
  } catch (cause) {
    throw new ChainReadError("CHAIN_RPC_FAILED", "The RPC's getAccountInfo call failed.", {
      cause,
    });
  }
  if (account === null) throw new PlatformConfigNotFoundError(address);
  const config = decodePlatformConfig(account.data);
  if (config.version !== CURRENT_ACCOUNT_VERSION) {
    throw new ChainReadError(
      "CHAIN_ACCOUNT_INVALID",
      `The PlatformConfig at ${address} is version ${String(config.version)}; this SDK reads version ${String(CURRENT_ACCOUNT_VERSION)}`,
      { reason: "version" },
    );
  }
  return { usdcMint: config.usdcMint, feeBps: config.feeBps, treasury: config.treasury };
}

/**
 * The settlement modes this client funds. The version-1 account layout has no refund on silence
 * (the binding: `refund` is offered from a future account layout), so `release` only.
 */
export const SUPPORTED_SETTLEMENT_MODES: readonly SettlementMode[] = ["release"];

/** Whether the entry's `extra.settlementMode` is one of {@link SUPPORTED_SETTLEMENT_MODES}. */
export function settlementModeSupported(entry: { extra: { settlementMode: unknown } }): boolean {
  return SUPPORTED_SETTLEMENT_MODES.some((mode) => mode === entry.extra.settlementMode);
}

export interface ParseEscrowAcceptContext {
  cluster: SolanaCluster;
  /** From {@link readPlatformConfig}: the entry's mint and fee must equal these. */
  platformConfig: PlatformConfigTerms;
  /** The buyer's own bound on what it deposits: `amount` plus the fee at `platformConfig.feeBps`. */
  maxDepositMicroUsdc: bigint;
  /** When given, the only worker the buyer funds. */
  payTo?: string;
  /** Decides an `acceptance` predicate the 402 carries; absent, such an entry is refused. */
  admitAcceptance?: (acceptance: Acceptance) => boolean;
  /** Unix milliseconds. */
  now?: () => number;
}

export interface EscrowAcceptSelection {
  readonly cluster: SolanaCluster;
  readonly resource: ResourceInfo;
  readonly entry: OnDeliveryAccept;
  readonly extension: EscroExtensionInfo | undefined;
  readonly extensions: Record<string, unknown> | undefined;
}

// The selections parseEscrowAccept returned, each funded at most once. Module-level: a selection
// parsed by one copy of the SDK and funded by another is unknown to the second, and refused.
const SELECTIONS = new WeakMap<EscrowAcceptSelection, "fresh" | "spent">();

/** The selection's state before this call, marking it spent: undefined when parse did not return it. */
export function spendSelection(selection: EscrowAcceptSelection): "fresh" | "spent" | undefined {
  const state = SELECTIONS.get(selection);
  if (state !== undefined) SELECTIONS.set(selection, "spent");
  return state;
}

const EXTRA_MEMBERS = [
  "program",
  "specHash",
  "specUri",
  "deadline",
  "reviewWindowSeconds",
  "feeBps",
  "feePayer",
  "settlementMode",
  "paymentFlow",
];

export const isOnDeliveryScheme = (value: unknown): value is OnDeliveryScheme =>
  value === "on-delivery" || value === "job-escrow";

const SPEC_HASH = /^[0-9a-f]{64}$/;

export const isSpecHash = (value: unknown): value is string =>
  typeof value === "string" && SPEC_HASH.test(value);

function isSpecUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "ipfs:";
  } catch {
    return false;
  }
}

const isPositiveSafeInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * An entry's `amount` as micro-USDC: a canonical decimal string (no sign, exponent, fraction,
 * whitespace or leading zero) from the minimum escrow to the largest safe integer; else undefined.
 */
export function amountOf(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const amount = BigInt(value);
  const inRange = amount >= BigInt(MIN_ESCROW_AMOUNT) && amount <= BigInt(Number.MAX_SAFE_INTEGER);
  return inRange ? amount : undefined;
}

type Extension =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "info"; info: EscroExtensionInfo };

function escroExtension(extensions: unknown): Extension {
  if (extensions === undefined) return { kind: "none" };
  // A present `extensions` that is not an object is malformed; echoed into the payment, it would
  // make that payment invalid V2 after the escrow is funded.
  if (!isRecord(extensions)) return { kind: "invalid" };
  if (!("escro" in extensions)) return { kind: "none" };
  const escro = extensions.escro;
  if (!isRecord(escro) || !isEscroExtensionInfo(escro.info)) return { kind: "invalid" };
  return { kind: "info", info: escro.info };
}

export function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const member of Object.values(value)) deepFreeze(member);
}

/** A deep-frozen structured clone of the 402; throws when it is not plain data. */
function frozenCopy(required: PaymentRequired): PaymentRequired {
  let copy: PaymentRequired;
  try {
    copy = structuredClone(required);
  } catch (cause) {
    throw new EscroError(
      "The 402 is not plain data and cannot be copied",
      "VALIDATION_ERROR",
      undefined,
      {
        cause,
      },
    );
  }
  deepFreeze(copy);
  return copy;
}

/** The entry's first failed client check, in the binding's order; undefined when it passes all. */
function refusalOf(
  entry: Record<string, unknown>,
  ctx: ParseEscrowAcceptContext,
  nowMs: number,
  extension: Extension,
): OnDeliveryAcceptRefusal | undefined {
  const { cluster, platformConfig } = ctx;
  const extra = entry.extra;
  if (!isRecord(extra)) return "extra_shape";
  if (entry.network !== getCaip2Network(cluster)) return "network";
  if (extra.program !== getProgramId(cluster)) return "program";
  if (entry.asset !== getUsdcMint(cluster) || entry.asset !== platformConfig.usdcMint) {
    return "asset";
  }
  if (extra.feeBps !== platformConfig.feeBps) return "fee_bps";
  if (!settlementModeSupported({ extra: { settlementMode: extra.settlementMode } })) {
    return "settlement_mode";
  }
  if (extra.reviewWindowSeconds !== ONCHAIN_TIMEOUT_SECONDS) return "review_window";
  if (extra.feePayer !== "client") return "fee_payer";
  if (extra.paymentFlow !== "upfront" && extra.paymentFlow !== "escrow") return "payment_flow";
  const amount = amountOf(entry.amount);
  if (amount === undefined) return "amount";
  if (amount + escrowFee(amount, platformConfig.feeBps) > ctx.maxDepositMicroUsdc) {
    return "over_limit";
  }
  const payTo = entry.payTo;
  if (typeof payTo !== "string" || !isCanonicalPubkey(payTo)) return "pay_to";
  if (ctx.payTo !== undefined && payTo !== ctx.payTo) return "pay_to";
  if (!isSpecHash(extra.specHash)) return "spec_hash";
  if (!isSpecUri(extra.specUri)) return "spec_uri";
  const deadline = extra.deadline;
  if (
    typeof deadline !== "number" ||
    !Number.isSafeInteger(deadline) ||
    deadline * 1_000 <= nowMs
  ) {
    return "deadline";
  }
  if (!isPositiveSafeInteger(entry.maxTimeoutSeconds)) return "max_timeout";
  if (!hasMembers(extra, EXTRA_MEMBERS)) return "extra_shape";
  if (extension.kind === "invalid") return "extension_invalid";
  if (extension.kind === "info") {
    const { settlement, acceptance } = extension.info;
    if (
      settlement !== undefined &&
      (settlement.reviewWindowSeconds !== extra.reviewWindowSeconds ||
        settlement.settlementMode !== extra.settlementMode ||
        settlement.feePayer !== extra.feePayer)
    ) {
      return "extension_terms";
    }
    if (acceptance !== undefined && ctx.admitAcceptance?.(acceptance) !== true) return "acceptance";
  }
  return undefined;
}

/**
 * The first `on-delivery` (or `job-escrow`) entry of the 402 that passes every client check of the
 * binding, against the cluster's pinned values, `ctx.platformConfig` and the buyer's own deposit
 * bound; entries of other schemes are ignored. The selection holds a deep-frozen copy of the 402's
 * resource, entry and extensions taken before the checks, and is the only input
 * {@link fundFromAccept} funds, once. Throws {@link OnDeliveryAcceptError} listing each candidate's
 * first refusal when none passes, and {@link EscroError} `VALIDATION_ERROR` when
 * `ctx.maxDepositMicroUsdc` is not a bigint or the 402 is not plain data.
 */
export function parseEscrowAccept(
  required: PaymentRequired,
  ctx: ParseEscrowAcceptContext,
): EscrowAcceptSelection {
  const bound: unknown = ctx.maxDepositMicroUsdc;
  if (typeof bound !== "bigint") {
    throw new EscroError(
      "parseEscrowAccept needs ctx.maxDepositMicroUsdc: the buyer's bigint bound on its deposit",
      "VALIDATION_ERROR",
    );
  }
  // The terms are checked and funded from one deep-frozen copy, so nothing holding the caller's
  // 402 can change them between the check and the create.
  const offer = frozenCopy(required);
  const nowMs = ctx.now?.() ?? Date.now();
  const extension = escroExtension(offer.extensions);
  const refusals: { index: number; reason: OnDeliveryAcceptRefusal }[] = [];
  for (const [index, offered] of offer.accepts.entries()) {
    const candidate: unknown = offered;
    if (!isRecord(candidate) || !isOnDeliveryScheme(candidate.scheme)) continue;
    const reason = refusalOf(candidate, ctx, nowMs, extension);
    if (reason !== undefined) {
      refusals.push({ index, reason });
      continue;
    }
    const selection: EscrowAcceptSelection = Object.freeze({
      cluster: ctx.cluster,
      resource: offer.resource,
      entry: offered as OnDeliveryAccept,
      extension: extension.kind === "info" ? extension.info : undefined,
      extensions: offer.extensions,
    });
    SELECTIONS.set(selection, "fresh");
    return selection;
  }
  throw new OnDeliveryAcceptError(
    refusals.length > 0 ? refusals : [{ index: -1, reason: "no_entry" }],
  );
}

export interface BuildEscrowAcceptOptions {
  cluster: SolanaCluster;
  amountMicroUsdc: bigint;
  payTo: string;
  specHash: string;
  specUri: string;
  /** Unix seconds. */
  deadline: number;
  /** PlatformConfig's `fee_bps`, read by {@link readPlatformConfig}. */
  feeBps: number;
  maxTimeoutSeconds: number;
  /** Default `upfront`. */
  paymentFlow?: "upfront" | "escrow";
}

function buildRefusal(options: BuildEscrowAcceptOptions): OnDeliveryAcceptRefusal | undefined {
  if (amountOf(options.amountMicroUsdc.toString()) === undefined) return "amount";
  const { feeBps } = options;
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 10_000) return "fee_bps";
  if (!isCanonicalPubkey(options.payTo)) return "pay_to";
  if (!isSpecHash(options.specHash)) return "spec_hash";
  if (!isSpecUri(options.specUri)) return "spec_uri";
  if (!Number.isSafeInteger(options.deadline)) return "deadline";
  if (!isPositiveSafeInteger(options.maxTimeoutSeconds)) return "max_timeout";
  return undefined;
}

/**
 * The `on-delivery` entry a worker advertises: network, asset, program, review window, settlement
 * mode and fee payer from the cluster's pinned values, the fee from `options.feeBps`. Throws
 * {@link OnDeliveryAcceptError} for an entry the client side would refuse on its own terms (an
 * amount under the minimum escrow, a malformed key, hash, URI or bound).
 */
export function buildEscrowAccept(options: BuildEscrowAcceptOptions): OnDeliveryAccept {
  const refusal = buildRefusal(options);
  if (refusal !== undefined) throw new OnDeliveryAcceptError([{ index: -1, reason: refusal }]);
  const { cluster } = options;
  return {
    scheme: "on-delivery",
    network: getCaip2Network(cluster),
    amount: options.amountMicroUsdc.toString(),
    asset: getUsdcMint(cluster),
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    extra: {
      program: getProgramId(cluster),
      specHash: options.specHash,
      specUri: options.specUri,
      deadline: options.deadline,
      reviewWindowSeconds: ONCHAIN_TIMEOUT_SECONDS,
      feeBps: options.feeBps,
      feePayer: "client",
      settlementMode: "release",
      paymentFlow: options.paymentFlow ?? "upfront",
    },
  };
}
