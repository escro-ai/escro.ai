// The devnet deploy tooling rewrites the devnet values after each devnet deploy; only the
// mainnet deploy tooling or a human mainnet bootstrap changes the mainnet values. The two
// clusters have distinct program ids and upgrade authorities, so a leaked devnet upgrade authority
// cannot upgrade mainnet.

export type SolanaCluster = "devnet" | "mainnet";

export const PROGRAM_ID_DEVNET = "EjLpJ3obUYk1f2KDensU7UdGBZTxSdxufm7CSnMA3H5C" as const;
export const PLATFORM_CONFIG_PDA_DEVNET = "5BYnq9YsCTaMxBLJhBn4TPnCQuxiHcG5eZ2ygLJBu9dc" as const;
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as const;
export const DEPLOYED_AT_DEVNET = "2026-08-15T17:24:37.149Z" as const;

export const PROGRAM_ID_MAINNET = "4CwLNRF4mFXutiBGjtMHQBxh8whW8T8EyvJXdRhY1rvr" as const;
export const PLATFORM_CONFIG_PDA_MAINNET = "7zPti535SmzvkdtmKaGR8w4niHLiEidWCqCaQXLbQvhn" as const;
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;
// Pinned mainnet PlatformConfig values: the treasury and oracle authority the program is
// configured with.
export const MAINNET_TREASURY = "GSNa5eHUkKUp3RQr8vYbQx471FzWztfMsvhNhW2MUBVq" as const;
export const MAINNET_ORACLE_AUTHORITY = "G2Cr4PAJ58ZSYX2ceCMt2DtP1KBFXA9oYDtJJKZaKKJT" as const;
// The 2-of-2 Squads vault: the treasury's address, named apart because the roles differ.
export const MAINNET_UPGRADE_AUTHORITY = "GSNa5eHUkKUp3RQr8vYbQx471FzWztfMsvhNhW2MUBVq" as const;
// The AdminConfig PDA, seeds [b"admin"] under PROGRAM_ID_MAINNET (a test derives it).
export const ADMIN_CONFIG_PDA_MAINNET = "9SoVXPDjKFKA6sEo5oVp1RHij2FKVR52SCvoD2ELDHgD" as const;
// MAINNET_TREASURY's associated token account for MAINNET_USDC_MINT (a test derives it).
export const MAINNET_TREASURY_USDC_ATA = "DAQfw4T3MzzfrWjkVy3mbWtWuUYVoaZThvsEF1RdM2kg" as const;

// An RPC proves its cluster by its genesis hash; the ops CLIs refuse a mismatch.
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as const;
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" as const;

// CAIP-2 ids: `solana:` plus the first 32 characters of the genesis hash (a test locks them to
// the hashes above and to the binding's appendix, docs/specs/scheme_on_delivery_svm.md).
export const SOLANA_CAIP2_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
export const SOLANA_CAIP2_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;

export function getCaip2Network(cluster: SolanaCluster): string {
  return cluster === "mainnet" ? SOLANA_CAIP2_MAINNET : SOLANA_CAIP2_DEVNET;
}

/** The cluster a CAIP-2 id names, exactly; undefined for any other string. */
export function clusterOfCaip2(network: string): SolanaCluster | undefined {
  if (network === SOLANA_CAIP2_MAINNET) return "mainnet";
  if (network === SOLANA_CAIP2_DEVNET) return "devnet";
  return undefined;
}

// The default API base per cluster: a mirror of the hosted API's domain name per cluster.
export const API_URLS: Record<SolanaCluster, string> = {
  devnet: "https://api-devnet.escro.ai",
  mainnet: "https://api.escro.ai",
};

export function getApiUrl(cluster: SolanaCluster): string {
  return API_URLS[cluster];
}

/** Solana's public RPC per cluster: the default where no keyed endpoint is configured. */
export const PUBLIC_RPC_URLS: Readonly<Record<SolanaCluster, string>> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

export function getPublicRpcUrl(cluster: SolanaCluster): string {
  return PUBLIC_RPC_URLS[cluster];
}

/** Platform oracle fee rate in basis points (50 bps = 0.50%). */
export const PLATFORM_FEE_BPS = 50 as const;

/**
 * The program's fee on an escrow `amount` at `feeBps`, in micro-USDC: `floor(amount * feeBps /
 * 10_000)`, as `create_escrow` computes it. The buyer deposits `amount` plus this fee.
 */
export function escrowFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / 10_000n;
}

/**
 * The minimum escrow `amount` in micro-USDC ($5.00): the worker's net, not the buyer's deposit
 * (amount plus the additive fee). Mirrors `MIN_ESCROW_AMOUNT` in the program; a test reads the
 * program source and fails on drift.
 */
export const MIN_ESCROW_AMOUNT = 5_000_000 as const;

/**
 * The account layout version the program writes and accepts. MIRROR of
 * `CURRENT_ACCOUNT_VERSION` in the program; a test reads the program source and fails on
 * drift.
 */
export const CURRENT_ACCOUNT_VERSION = 1 as const;

/**
 * The most UTF-8 bytes `raise_dispute` accepts as a reason. MIRROR of the program's
 * `MAX_REASON_LEN` in its `raise_dispute` instruction; a test reads the program source and fails
 * on drift. Checked off chain by `disputeReasonError`.
 */
export const MAX_DISPUTE_REASON_BYTES = 200 as const;

/**
 * The most UTF-8 bytes `create_escrow`'s `spec_hash` may hold. MIRROR of `#[max_len(64)]` on
 * `spec_hash` in the program's `EscrowAccount`; a test reads the program source and fails on
 * drift. The program bounds the field only by the account's allocation; the
 * API's create builder enforces this cap.
 */
export const MAX_SPEC_HASH_BYTES = 64 as const;

/**
 * The most UTF-8 bytes `submit_deliverable`'s `proof_uri` may hold. MIRROR of the `#[max_len]` on
 * `proof_uri` in the program's `EscrowAccount`; a test reads the program source and fails on
 * drift. The program bounds the field only by the account's allocation; the
 * API's submit builder enforces this cap. Checked off chain by `proofUriError`.
 */
export const MAX_PROOF_URI_BYTES = 128 as const;

/**
 * Indeterminate settlement reads one escrow may accrue before the oracle stops retrying it and
 * alerts once. Each one follows a read that found the escrow's account closed, so an escrow past
 * the bound has nothing left to sign. Every off-chain reader of the bound reads this one constant.
 */
export const RECONCILE_ATTEMPT_BOUND = 5;

// Mirrors of refund_buyer.rs REFUND_GRACE_SECONDS and timeout_release.rs TIMEOUT_SECONDS (the
// non-feature builds); a test reads the program source and fails on drift.
export const ONCHAIN_REFUND_GRACE_SECONDS = 900 as const;
export const ONCHAIN_TIMEOUT_SECONDS = 86_400 as const;

/**
 * The cluster clock lags wall clock, so an off-chain gate that must clear an on-chain one runs
 * at the on-chain offset plus this margin; at the bare boundary the chain still rejects.
 */
export const CLOCK_SKEW_SECONDS = 60 as const;

export const SCANNER_REFUND_GRACE_SECONDS = (ONCHAIN_REFUND_GRACE_SECONDS +
  CLOCK_SKEW_SECONDS) as 960;
export const SCANNER_TIMEOUT_SECONDS = (ONCHAIN_TIMEOUT_SECONDS + CLOCK_SKEW_SECONDS) as 86_460;

/**
 * The furthest escrow deadline, in seconds from now, an agent-driven pay surface accepts (7 days): the
 * ceiling and the default of the MCP's, SAK's and Eliza's pay bound.
 */
export const PAY_MAX_DEADLINE_SECONDS = 604_800 as const;

/** The System Program address: no program deploys there, so it marks an unbootstrapped mainnet. */
export const MAINNET_PROGRAM_ID_PLACEHOLDER = "11111111111111111111111111111111" as const;

export function getProgramId(cluster: SolanaCluster): string {
  return cluster === "mainnet" ? PROGRAM_ID_MAINNET : PROGRAM_ID_DEVNET;
}

export function getPlatformConfigPda(cluster: SolanaCluster): string {
  return cluster === "mainnet" ? PLATFORM_CONFIG_PDA_MAINNET : PLATFORM_CONFIG_PDA_DEVNET;
}

export function getUsdcMint(cluster: SolanaCluster): string {
  return cluster === "mainnet" ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;
}

export function isPlaceholderProgramId(id: string): boolean {
  return id === MAINNET_PROGRAM_ID_PLACEHOLDER;
}

/** Throws on mainnet while the program id is the placeholder; call at module init. */
export function assertProgramIdNotPlaceholder(id: string, cluster: SolanaCluster): void {
  if (cluster === "mainnet" && isPlaceholderProgramId(id)) {
    throw new Error(
      `PROGRAM_ID_MAINNET is still the System Program placeholder (${MAINNET_PROGRAM_ID_PLACEHOLDER}). ` +
        "This build carries no deployed mainnet program id: use a release built after the " +
        "mainnet bootstrap.",
    );
  }
}

export function parseClusterEnv(raw: string | undefined): SolanaCluster {
  if (raw === "mainnet") return "mainnet";
  if (raw === "devnet" || raw === undefined || raw === "") return "devnet";
  throw new Error(`CLUSTER env var must be "devnet" or "mainnet", got "${raw}"`);
}
