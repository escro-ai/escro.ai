// The worker's own `exact` entry: the cluster's USDC paid straight to the worker, the transaction fee paid by the
// facilitator's fee payer. Network and asset come from config, never from the caller.
import {
  getCaip2Network,
  getUsdcMint,
  type PaymentRequirements,
  type SolanaCluster,
  type SupportedResponse,
} from "@escro/shared";
import { isCanonicalPubkey } from "@escro/shared/solana";

import { ExactAcceptError } from "./errors.js";

const U64_MAX = 2n ** 64n - 1n;
/** Below this a facilitator's verify and settle cannot both land inside the buyer's window. */
const MIN_MAX_TIMEOUT_SECONDS = 10;
/** An hour: the menu times the paid answer with `setTimeout`, which overflows above about 2 147 483 s. */
const MAX_MAX_TIMEOUT_SECONDS = 3_600;

export interface BuildExactAcceptOptions {
  cluster: SolanaCluster;
  amountMicroUsdc: bigint;
  /** The worker's own wallet. */
  payTo: string;
  /** The facilitator's fee payer, from its `/supported` answer ({@link exactFeePayer}). */
  feePayer: string;
  maxTimeoutSeconds: number;
}

/**
 * The `exact` entry a worker offers beside its `on-delivery` entry. Throws {@link ExactAcceptError} for a `payTo` or
 * `feePayer` that is not a canonical key, a fee payer that is the worker itself, an amount outside 1..2^64-1, or a
 * `maxTimeoutSeconds` that is not a whole number from 10 to 3600.
 */
export function buildExactAccept(options: BuildExactAcceptOptions): PaymentRequirements {
  const { cluster, amountMicroUsdc, payTo, feePayer, maxTimeoutSeconds } = options;
  if (!isCanonicalPubkey(payTo)) {
    throw new ExactAcceptError("pay_to", "payTo is not a canonical public key");
  }
  if (!isCanonicalPubkey(feePayer)) {
    throw new ExactAcceptError("fee_payer", "The fee payer is not a canonical public key");
  }
  if (feePayer === payTo) {
    throw new ExactAcceptError("fee_payer", "The fee payer is the worker's own wallet");
  }
  if (amountMicroUsdc < 1n || amountMicroUsdc > U64_MAX) {
    throw new ExactAcceptError("amount", "The amount is not between 1 and 2^64 - 1 micro-USDC");
  }
  if (
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < MIN_MAX_TIMEOUT_SECONDS ||
    maxTimeoutSeconds > MAX_MAX_TIMEOUT_SECONDS
  ) {
    throw new ExactAcceptError(
      "max_timeout",
      `maxTimeoutSeconds must be a whole number from ${String(MIN_MAX_TIMEOUT_SECONDS)} to ${String(MAX_MAX_TIMEOUT_SECONDS)}`,
    );
  }
  return {
    scheme: "exact",
    network: getCaip2Network(cluster),
    amount: amountMicroUsdc.toString(),
    asset: getUsdcMint(cluster),
    payTo,
    maxTimeoutSeconds,
    extra: { feePayer },
  };
}

/**
 * The `extra.feePayer` of the first x402 V2 `exact` kind on the cluster's network in a facilitator's `/supported`
 * answer; undefined when none names one. Its validity is {@link buildExactAccept}'s to check.
 */
export function exactFeePayer(
  supported: SupportedResponse,
  cluster: SolanaCluster,
): string | undefined {
  const network = getCaip2Network(cluster);
  for (const kind of supported.kinds) {
    if (kind.x402Version !== 2 || kind.scheme !== "exact" || kind.network !== network) continue;
    const feePayer = kind.extra?.feePayer;
    if (typeof feePayer === "string") return feePayer;
  }
  return undefined;
}
