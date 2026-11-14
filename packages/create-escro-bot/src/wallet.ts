import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";
import nacl from "tweetnacl";

export interface GeneratedWallet {
  /** Base58-encoded public key (the on-chain address). The only thing surfaced. */
  publicKey: string;
}

const KEYFILE = "keypair.json";

/**
 * Generate a fresh local Solana keypair and write it to
 * `<walletDir>/keypair.json` in the standard Solana keyfile format (a JSON
 * array of the 64 ed25519 secret-key bytes), owner-only (0600). The kit never
 * accepts a pasted key and never transmits or logs key material: only the
 * base58 public key is returned. Refuses to overwrite an existing keyfile so a
 * re-scaffold can never clobber a wallet that may already hold funds.
 */
export function generateWallet(walletDir: string): GeneratedWallet {
  const keyfile = join(walletDir, KEYFILE);
  if (existsSync(keyfile)) {
    throw new Error(
      `A wallet already exists at ${keyfile}. Refusing to overwrite it; remove it deliberately if you mean to replace the key.`,
    );
  }

  const { publicKey, secretKey } = nacl.sign.keyPair();

  mkdirSync(walletDir, { recursive: true, mode: 0o700 });
  // Serialise the 64-byte secret key as a JSON number array (Solana keyfile
  // format). Write owner-only, then chmod to pin 0600 regardless of umask.
  writeFileSync(keyfile, `${JSON.stringify(Array.from(secretKey))}\n`, { mode: 0o600 });
  chmodSync(keyfile, 0o600);

  return { publicKey: bs58.encode(publicKey) };
}
