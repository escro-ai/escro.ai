import { MAX_DISPUTE_REASON_BYTES, MAX_PROOF_URI_BYTES } from "../config.js";
import { storableText } from "./text.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant violation: ${message}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Why `reason` cannot go on chain as a dispute reason, or null when it can. The program
 * counts UTF-8 bytes, so a short reason of multi-byte characters can still be too long.
 */
export function disputeReasonError(reason: string): string | null {
  if (!storableText(reason)) return "reason must not hold U+0000";
  if (reason.length === 0) return "reason must not be empty";
  const bytes = new TextEncoder().encode(reason).length;
  if (bytes > MAX_DISPUTE_REASON_BYTES) {
    return `reason is ${String(bytes)} bytes in UTF-8; the program accepts at most ${String(MAX_DISPUTE_REASON_BYTES)}`;
  }
  return null;
}

/** Schemes a stored deliverable or evidence URL may use: none that runs, inlines or reads files. */
export const SAFE_URL_SCHEMES = ["http:", "https:", "ipfs:", "ar:"] as const;

export function isSafeUrl(value: string): boolean {
  try {
    return (SAFE_URL_SCHEMES as readonly string[]).includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Why `uri` cannot be submitted as a deliverable's `proofUri`, or null when it can. The on-chain
 * `proof_uri` allocation counts UTF-8 bytes, so a URI whose UTF-16 length fits can still be too long.
 */
export function proofUriError(uri: string): string | null {
  if (!storableText(uri)) return "proofUri must not hold U+0000";
  if (!isSafeUrl(uri)) return "proofUri must be an http(s), ipfs or ar URL";
  const bytes = new TextEncoder().encode(uri).length;
  if (bytes > MAX_PROOF_URI_BYTES) {
    return `proofUri is ${String(bytes)} bytes in UTF-8; the program allocates at most ${String(MAX_PROOF_URI_BYTES)}`;
  }
  return null;
}

export * from "./canonicalize.js";
