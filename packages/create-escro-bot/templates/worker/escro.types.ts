// No on-chain constants (program id, USDC mint, minimums) live here: they resolve at runtime
// from @escro/sdk, so a scaffold never ships stale addresses. The config shape is inferred
// from the schema in escro.config.ts.

export type SolanaCluster = "devnet" | "mainnet";

export const ADAPTER_IDS = [
  "gradients",
  "ridges",
  "404gen",
  "lium",
  "akash",
  "render",
  "gensyn",
  "zkml",
  "custom",
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];
