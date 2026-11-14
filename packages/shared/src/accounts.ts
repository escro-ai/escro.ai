// The PlatformConfig account layout, the one off-chain copy; a test locks it to the program's
// committed IDL.
import bs58 from "bs58";

/** Byte offsets after the 8-byte discriminator, and the account length. */
export const PLATFORM_CONFIG_LAYOUT = {
  version: 8,
  fee_bps: 9,
  oracle_authority: 11,
  usdc_mint: 43,
  treasury: 75,
  bump: 107,
  length: 108,
} as const;

/** `sha256("account:PlatformConfig")[0..8]`. */
export const PLATFORM_CONFIG_DISCRIMINATOR: readonly number[] = [
  160, 78, 128, 0, 248, 83, 230, 160,
];

export interface PlatformConfigAccount {
  version: number;
  feeBps: number;
  oracleAuthority: string;
  usdcMint: string;
  treasury: string;
  bump: number;
}

/**
 * Decode PlatformConfig account data. Throws on a wrong length or discriminator; the
 * version is returned for the caller to check against `CURRENT_ACCOUNT_VERSION`.
 */
export function decodePlatformConfig(data: Uint8Array): PlatformConfigAccount {
  const L = PLATFORM_CONFIG_LAYOUT;
  if (data.length !== L.length) {
    throw new Error(
      `PlatformConfig account is ${String(data.length)} bytes, expected ${String(L.length)}`,
    );
  }
  if (PLATFORM_CONFIG_DISCRIMINATOR.some((byte, i) => data[i] !== byte)) {
    throw new Error("PlatformConfig discriminator mismatch: not a PlatformConfig account");
  }
  const byte = (at: number): number => data[at] ?? 0;
  const key = (at: number): string => bs58.encode(data.subarray(at, at + 32));
  return {
    version: byte(L.version),
    feeBps: byte(L.fee_bps) | (byte(L.fee_bps + 1) << 8),
    oracleAuthority: key(L.oracle_authority),
    usdcMint: key(L.usdc_mint),
    treasury: key(L.treasury),
    bump: byte(L.bump),
  };
}
