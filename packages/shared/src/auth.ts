import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { Keypair } from "@solana/web3.js";

/** Lowercase hex SHA-256 of a UTF-8 string. Use "" for no-body requests. */
export function hashBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** Canonical signed message format shared by SDK (signing) and API (verification). */
export function buildSignedMessage(
  timestamp: number | string,
  method: string,
  fullPath: string,
  bodyHash: string,
): string {
  return `escro:${String(timestamp)}:${method}:${fullPath}:${bodyHash}`;
}

/**
 * Build all auth headers from a raw Ed25519 secret key and its base58 wallet
 * address. This is the web3.js-free core of {@link signRequest}: callers that
 * cannot depend on `@solana/web3.js` (the Bot Kit CLI keeps its runtime light)
 * sign with the raw keyfile bytes here, so the header names and the `escro:`
 * message format live in exactly ONE place and cannot drift from the API's
 * verifier. `rawBody` is the raw UTF-8 request body; pass "" when there is none.
 */
export function signRequestRaw(
  secretKey: Uint8Array,
  walletAddress: string,
  method: string,
  fullPath: string,
  rawBody: string,
): Record<string, string> {
  const timestamp = Date.now();
  const bodyHash = hashBody(rawBody);
  const message = buildSignedMessage(timestamp, method, fullPath, bodyHash);
  const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), secretKey);
  return {
    "x-wallet-address": walletAddress,
    "x-signature": bs58.encode(sigBytes),
    "x-timestamp": String(timestamp),
    "x-content-sha256": bodyHash,
  };
}

/**
 * Build all auth headers needed for an authenticated request.
 * `rawBody` is the raw UTF-8 request body string; pass "" when there is no body.
 */
export function signRequest(
  wallet: Keypair,
  method: string,
  fullPath: string,
  rawBody: string,
): Record<string, string> {
  return signRequestRaw(wallet.secretKey, wallet.publicKey.toBase58(), method, fullPath, rawBody);
}
