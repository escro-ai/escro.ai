// The `exact` scheme over the official client. @x402/svm 2.29.0 is reached only
// through the one lazy import below, so a process that never pays `exact` never executes it. The
// transaction layout the signer holds it to is the scheme spec at commit
// e4a086819f419e9395acbbdc1679fe6627029ff7 of x402-foundation/x402
// (specs/schemes/exact/scheme_exact_svm.md), the release commit of 2.29.0, not main.
import type { Keypair, PublicKey } from "@solana/web3.js";
import {
  getUsdcMint,
  type PaymentPayload,
  type PaymentRequirements,
  type SolanaCluster,
} from "@escro/shared";
import { isCanonicalPubkey } from "@escro/shared/solana";
import type {
  PaymentPayload as CorePaymentPayload,
  PaymentRequirements as CorePaymentRequirements,
} from "@x402/core/types";

import { EscroPayError, EscroRailNotEnabledError } from "../errors.js";
import { guardedSigner } from "./signer.js";

// The official client fixes the payment's compute budget at 20000 units and the Memo program's cost
// depends on the character, so no byte count alone bounds what lands: one emoji does not fit. 32 is
// the length of the client's own memo-less nonce and fits the costliest printable content measured.
const MAX_MEMO_BYTES = 32;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

// Upstream drift in the wire types this module adapts is a red typecheck here, not a runtime
// surprise. Upstream types x402Version as `number` and a resource without the shared type's index
// signature; those two fields are the SDK's own to set.
type Assignable<From extends To, To> = From;
export type ExactWireTypes = [
  Assignable<CorePaymentRequirements, PaymentRequirements>,
  Assignable<
    Pick<CorePaymentPayload, "accepted" | "payload">,
    Pick<PaymentPayload, "accepted" | "payload">
  >,
];

function refuse(detail: string, message: string): never {
  throw new EscroPayError("requirements", message, { detail });
}

function isMemoAllowed(memo: unknown): boolean {
  return typeof memo === "string" && memo.length <= MAX_MEMO_BYTES && PRINTABLE_ASCII.test(memo);
}

function isVersionListAllowed(versions: unknown): boolean {
  return (
    Array.isArray(versions) && versions.includes(0) && versions.every((v) => v === 0 || v === 1)
  );
}

/**
 * Refuses an `exact` entry the bot will not pay, before the cap is touched and before the package
 * is loaded. The network, `payTo` and amount are already bound to the caller's own terms.
 */
export function checkExactRequirements(
  entry: PaymentRequirements,
  wallet: PublicKey,
  cluster: SolanaCluster,
): void {
  if (entry.asset !== getUsdcMint(cluster)) {
    refuse("mint", "The entry's asset is not the cluster's USDC");
  }
  const extra = entry.extra ?? {};
  const { feePayer } = extra;
  if (typeof feePayer !== "string" || !isCanonicalPubkey(feePayer)) {
    refuse("fee_payer", "The entry's extra.feePayer is not a public key");
  }
  if (feePayer === wallet.toBase58()) {
    refuse("fee_payer", "The entry names the bot's own key as extra.feePayer");
  }
  if ("splits" in extra && !(Array.isArray(extra.splits) && extra.splits.length === 0)) {
    refuse("splits", "The entry's extra.splits would pay a third party");
  }
  if (extra.ataCreationRequired === true) {
    refuse("ata_creation", "The entry would have the bot fund a token account");
  }
  if ("memo" in extra && !isMemoAllowed(extra.memo)) {
    refuse(
      "memo",
      `The entry's extra.memo must be 1 to ${String(MAX_MEMO_BYTES)} bytes of printable ASCII`,
    );
  }
  if ("transactionVersions" in extra && !isVersionListAllowed(extra.transactionVersions)) {
    refuse("transaction_version", "The entry's extra.transactionVersions does not admit version 0");
  }
  if (!Number.isSafeInteger(entry.maxTimeoutSeconds) || entry.maxTimeoutSeconds <= 0) {
    refuse("max_timeout", "The entry's maxTimeoutSeconds is not a positive whole number");
  }
}

/**
 * Builds and signs the payment for a checked entry. A scheme instance is built per payment, under a
 * signer good for that payment only, against the client's own RPC URL (the scheme otherwise uses a
 * public one). A failed load of the package rejects {@link EscroRailNotEnabledError}; a scheme error
 * rejects {@link EscroPayError} `transaction`/`build`; the signer's own refusals reach the caller
 * unwrapped.
 */
export async function exactPayload(
  entry: PaymentRequirements,
  deps: {
    wallet: Keypair;
    cluster: SolanaCluster;
    rpcUrl: string;
    onSigned: (memo: string) => void;
  },
): Promise<{ transaction: string }> {
  let client: typeof import("@x402/svm/exact/client");
  try {
    client = await import("@x402/svm/exact/client");
  } catch (cause) {
    throw new EscroRailNotEnabledError("x402", { cause });
  }
  const buildRefusal = (cause: unknown): EscroPayError =>
    new EscroPayError("transaction", "The x402 scheme client could not build the payment", {
      detail: "build",
      cause,
    });
  let transaction: unknown;
  try {
    const signer = guardedSigner(deps.wallet, entry, deps.cluster, deps.onSigned);
    const scheme = new client.ExactSvmScheme(signer, { rpcUrl: deps.rpcUrl });
    // checkExactRequirements has established `extra`.
    const { payload } = await scheme.createPaymentPayload(2, entry as CorePaymentRequirements);
    transaction = payload.transaction;
  } catch (err) {
    if (err instanceof EscroPayError) throw err;
    throw buildRefusal(err);
  }
  if (typeof transaction !== "string") {
    throw buildRefusal(new Error("the scheme client returned no transaction"));
  }
  return { transaction };
}
