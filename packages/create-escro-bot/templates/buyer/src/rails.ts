import { parseUsdc } from "@escro/sdk";
import type { Rail, X402SpendCap } from "@escro/sdk";

/**
 * The client's x402 budget: the configured amount when `x402` is listed, else zero. Always a cap,
 * because a client with none pays x402 uncapped on devnet and is refused on mainnet.
 */
export function x402SpendCapFor(rails: readonly Rail[], x402SpendCapUsdc: number): X402SpendCap {
  return { maxMicroUsdc: rails.includes("x402") ? parseUsdc(String(x402SpendCapUsdc)) : 0 };
}
