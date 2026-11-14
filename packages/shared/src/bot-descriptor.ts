import nacl from "tweetnacl";
import bs58 from "bs58";
import { canonicalize } from "./utils/canonicalize.js";
import type { BotDescriptor, UnsignedBotDescriptor } from "./types/bots.js";

/**
 * Canonical, deterministic byte-string a bot signs to prove authorship of its
 * capability descriptor, so anyone can verify the signature independently.
 * Excludes `signature` itself. Shared by the SDK/kit (signing)
 * and the API (verification) so both sides agree byte-for-byte.
 */
export function canonicalBotDescriptorMessage(descriptor: UnsignedBotDescriptor): string {
  // `canonicalize` sorts keys and drops undefined values, so an absent
  // `endpoint` is naturally excluded and signing is order-independent.
  return canonicalize({
    wallet: descriptor.wallet,
    role: descriptor.role,
    capabilities: descriptor.capabilities,
    serviceRef: descriptor.serviceRef,
    pricingHint: descriptor.pricingHint,
    endpoint: descriptor.endpoint,
    signedAt: descriptor.signedAt,
  });
}

/**
 * Sign an unsigned descriptor with the bot's Ed25519 secret key, returning the
 * base58 detached signature to attach as `BotDescriptor.signature`.
 */
export function signBotDescriptor(
  secretKey: Uint8Array,
  descriptor: UnsignedBotDescriptor,
): string {
  const message = new TextEncoder().encode(canonicalBotDescriptorMessage(descriptor));
  return bs58.encode(nacl.sign.detached(message, secretKey));
}

/**
 * Verify a descriptor's `signature` against its own `wallet`. Returns false on a
 * wrong signer, a tampered field, or malformed encoding - never throws. This is
 * the document-level check any third party can run; the API also enforces it.
 */
export function verifyBotDescriptorSignature(descriptor: BotDescriptor): boolean {
  try {
    const { signature, ...unsigned } = descriptor;
    const message = new TextEncoder().encode(canonicalBotDescriptorMessage(unsigned));
    const signatureBytes = bs58.decode(signature);
    if (signatureBytes.length !== 64) return false;
    const pubkeyBytes = bs58.decode(descriptor.wallet);
    if (pubkeyBytes.length !== 32) return false;
    return nacl.sign.detached.verify(message, signatureBytes, pubkeyBytes);
  } catch {
    return false;
  }
}
