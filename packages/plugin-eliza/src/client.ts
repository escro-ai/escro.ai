import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Escro, parseUsdc } from "@escro/sdk";
import type { SpendCap } from "@escro/sdk";
import { getApiUrl, getPublicRpcUrl, parseClusterEnv } from "@escro/shared";
import type { SolanaCluster } from "@escro/shared";
import type { IAgentRuntime } from "./eliza.js";
import { EscroConfigError } from "./errors.js";

/**
 * The SDK methods the plugin uses, all as the buyer: it commissions, funds a 402 on the escrow
 * rail, reads the directory, EscroRep and an escrow, and settles only through the operator's own
 * predicate. It never judges a deliverable.
 */
export type EscroClient = Pick<
  Escro,
  | "createEscrow"
  | "pay"
  | "getEscrow"
  | "releaseWithPredicate"
  | "raiseDispute"
  | "findWorkers"
  | "listReputations"
>;

/** Resolved connection settings for the Escro SDK client. */
export interface EscroClientConfig {
  cluster: SolanaCluster;
  rpcUrl: string;
  apiUrl: string;
}

/** A setting as a non-empty string, else undefined: the one reading of "unset" the plugin uses. */
export function readString(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveClientConfig(runtime: IAgentRuntime): EscroClientConfig {
  let cluster: SolanaCluster;
  try {
    cluster = parseClusterEnv(readString(runtime, "ESCRO_CLUSTER"));
  } catch (err) {
    throw new EscroConfigError(
      `ESCRO_CLUSTER is invalid: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return {
    cluster,
    rpcUrl: readString(runtime, "ESCRO_RPC_URL") ?? getPublicRpcUrl(cluster),
    // The cluster's own API: a devnet agent on the mainnet API builds for the wrong program.
    apiUrl: readString(runtime, "ESCRO_API_URL") ?? getApiUrl(cluster),
  };
}

export function loadWalletFromRuntime(runtime: IAgentRuntime): Keypair {
  const secret = readString(runtime, "ESCRO_WALLET_SECRET");
  if (secret === undefined) {
    throw new EscroConfigError(
      "ESCRO_WALLET_SECRET is required (base58-encoded ed25519 secret key).",
    );
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(secret));
  } catch (err) {
    // The error never quotes the secret.
    throw new EscroConfigError(
      "ESCRO_WALLET_SECRET is not a valid base58-encoded ed25519 secret key.",
      { cause: err },
    );
  }
}

/**
 * The operator's `ESCRO_SPEND_CAP_USDC` setting: the most USDC the agent's wallet may hold in
 * open escrows, deposits (amount plus fee) counted. It is never read from a commission.
 */
function resolveSpendCap(runtime: IAgentRuntime): SpendCap | undefined {
  const value = runtime.getSetting("ESCRO_SPEND_CAP_USDC");
  if (value === null || value === undefined || value === "") return undefined;
  const invalid =
    `ESCRO_SPEND_CAP_USDC must be a USDC amount such as "50" or "12.5" (at most six ` +
    `decimals): ${String(value)}`;
  if (typeof value === "boolean") throw new EscroConfigError(invalid);
  try {
    return { maxOutstandingMicroUsdc: parseUsdc(String(value)) };
  } catch (err) {
    throw new EscroConfigError(invalid, { cause: err });
  }
}

export function createEscroClientFromRuntime(runtime: IAgentRuntime): EscroClient {
  const wallet = loadWalletFromRuntime(runtime);
  const { cluster, rpcUrl, apiUrl } = resolveClientConfig(runtime);
  const spendCap = resolveSpendCap(runtime);
  return new Escro({
    cluster,
    rpcUrl,
    apiUrl,
    wallet,
    ...(spendCap !== undefined && { spendCap }),
  });
}
