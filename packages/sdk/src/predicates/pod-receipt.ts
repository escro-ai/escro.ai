import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { isCanonicalPubkey } from "@escro/shared/solana";

import { PredicateParamsError, paramsObject, sha256Hex, type Predicate } from "./core.js";

interface PodReceiptParams {
  signer: Uint8Array;
}

// Both strings are bounded before any decode: base58 decoding is quadratic, so an unbounded
// string from a worker or a server could hang the buyer until the 24 h auto-release pays.
const MIN_SIGNER = 32;
const MAX_SIGNER = 44;
const MAX_RECEIPT = 88;

const fail = (reason: string) => Promise.resolve({ decision: "fail" as const, reason });

const predicate: Predicate<PodReceiptParams> = {
  name: "pod-receipt",
  parseParams(raw) {
    const { signer } = paramsObject("pod-receipt", raw, ["signer"]);
    if (typeof signer !== "string" || signer.length < MIN_SIGNER || signer.length > MAX_SIGNER) {
      throw new PredicateParamsError(
        `pod-receipt signer must be a base58 key of ${String(MIN_SIGNER)} to ${String(MAX_SIGNER)} characters`,
      );
    }
    if (!isCanonicalPubkey(signer)) {
      throw new PredicateParamsError("pod-receipt signer is not a canonical base58 ed25519 key");
    }
    return { signer: new PublicKey(signer).toBytes() };
  },
  evaluate(delivery, params) {
    const { receipt } = delivery;
    if (typeof receipt !== "string") return fail("the delivery carries no receipt");
    if (receipt.length > MAX_RECEIPT) {
      return fail(
        `the receipt is ${String(receipt.length)} characters; a signature is at most ${String(MAX_RECEIPT)}`,
      );
    }
    const signature = bs58.decodeUnsafe(receipt);
    if (signature?.length !== nacl.sign.signatureLength) {
      return fail("the receipt is not a base58 ed25519 signature");
    }
    const message = Buffer.from(`escro:pod:${sha256Hex(delivery.bytes)}`, "utf8");
    return nacl.sign.detached.verify(message, signature, params.signer)
      ? Promise.resolve({ decision: "pass", reason: "the signer's receipt covers this delivery" })
      : fail("the receipt is not the signer's over this delivery's hash");
  },
};

export const podReceipt: Predicate = predicate;
