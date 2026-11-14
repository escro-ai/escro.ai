import { isCanonicalPubkey } from "@escro/shared/solana";
import { EscroError } from "./errors.js";

/** Why an address argument was refused; the refusal names the parameter, never the value. */
export const PUBLIC_KEY_ISSUE = "must be a base-58 public key";

/**
 * Throws an {@link EscroError} with code `VALIDATION_ERROR` unless `value` is a public key exactly
 * as web3.js prints it. Every address the SDK puts in a request path or query passes here first,
 * so a malformed one reaches no such request. The message leaves the
 * value out: it is caller input, and may be anything.
 */
export function assertPublicKey(param: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !isCanonicalPubkey(value)) {
    throw new EscroError(`${param} ${PUBLIC_KEY_ISSUE}`, "VALIDATION_ERROR");
  }
}
