// The buyer's presentation signature (docs/specs/scheme_on_delivery_svm.md, "Buyer message"): the
// only message the buyer's key signs under x402/, and its only signing site.
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { Keypair } from "@solana/web3.js";
import { buildSignedMessage, type OnDeliveryPayloadFields } from "@escro/shared";
import { isCanonicalPubkey } from "@escro/shared/solana";

import { EscroError } from "../errors.js";

/** The buyer message's method place: a value no API route accepts. */
export const BUYER_MESSAGE_METHOD = "ON-DELIVERY" as const;

/** An absolute http: or https: URL: a path alone could make the message an API request's. */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** A Unix-millisecond timestamp the message can carry: a non-negative safe integer. */
export function isSignedAt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `escro:<signedAt>:ON-DELIVERY:<resourceUrl>:<escrow>`: the API's request message shape with a
 * method no API route accepts and an absolute URL in the path place, so it never verifies as an API
 * request signature. Throws on a `resourceUrl` that is not an absolute http(s) URL, an `escrow` that
 * is not a canonical base58 key, or a `signedAt` that is not a non-negative safe integer.
 */
export function buyerMessage(signedAt: number, resourceUrl: string, escrow: string): string {
  if (!isAbsoluteHttpUrl(resourceUrl)) {
    throw new EscroError(
      "The resource URL of a buyer message must be an absolute http: or https: URL",
      "VALIDATION_ERROR",
    );
  }
  if (!isCanonicalPubkey(escrow)) {
    throw new EscroError(
      "The escrow of a buyer message must be a canonical base58 public key",
      "VALIDATION_ERROR",
    );
  }
  if (!isSignedAt(signedAt)) {
    throw new EscroError(
      "signedAt must be a non-negative safe integer of Unix milliseconds",
      "VALIDATION_ERROR",
    );
  }
  return buildSignedMessage(signedAt, BUYER_MESSAGE_METHOD, resourceUrl, escrow);
}

/**
 * The payload fields signed by `wallet` over the buyer message for `resourceUrl`, `signedAt` being
 * `now()`. A poll re-signs with the poll URL and a fresh `now()`.
 */
export function signEscrowPayload(
  fields: Pick<OnDeliveryPayloadFields, "escrow" | "buyer" | "taskId" | "createSignature">,
  options: { wallet: Keypair; resourceUrl: string; now?: () => number },
): OnDeliveryPayloadFields {
  const signedAt = options.now?.() ?? Date.now();
  const message = buyerMessage(signedAt, options.resourceUrl, fields.escrow);
  const signature = nacl.sign.detached(new TextEncoder().encode(message), options.wallet.secretKey);
  return {
    escrow: fields.escrow,
    buyer: fields.buyer,
    taskId: fields.taskId,
    createSignature: fields.createSignature,
    signedAt,
    buyerSignature: bs58.encode(signature),
  };
}
