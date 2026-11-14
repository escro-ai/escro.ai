import { Keypair } from "@solana/web3.js";
import { parseClusterEnv, type SolanaCluster } from "@escro/shared";
import { parseUsdc } from "@escro/sdk";
import bs58 from "bs58";

export interface McpEnv {
  apiUrl: string;
  rpcUrl: string;
  /** Solana cluster (devnet/mainnet) the SDK targets for program ID + USDC mint. */
  cluster: SolanaCluster;
  /** Wallet keypair, or null when running in read-only mode. */
  wallet: Keypair | null;
  /**
   * `ESCRO_SPEND_CAP_USDC` in micro-USDC: the most the wallet may hold in open escrows,
   * deposits (amount plus fee) counted. Unset, a mainnet create_escrow is refused.
   */
  spendCapMicroUsdc?: number;
  /**
   * Registers verify_escrow_onchain, which reads the chain through `rpcUrl`. Set by `loadEnv` (the
   * stdio server); the API's hosted server leaves it unset, so its RPC serves no anonymous reads.
   */
  chainRead?: boolean;
  /** `ESCRO_PAY_402_ALLOW_PRIVATE_HOSTS=1`: pay_402 may reach loopback, link-local and private hosts. */
  pay402AllowPrivateHosts?: boolean;
}

function parseSecret(raw: string): Keypair {
  const trimmed = raw.trim();
  // JSON byte array (e.g. contents of a Solana CLI keypair file).
  if (trimmed.startsWith("[")) {
    const bytes = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  // Base58-encoded secret key.
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function loadEnv(): McpEnv {
  const apiUrl = process.env.ESCRO_API_URL;
  const rpcUrl = process.env.ESCRO_RPC_URL;
  if (!apiUrl) throw new Error("ESCRO_API_URL is required");
  if (!rpcUrl) throw new Error("ESCRO_RPC_URL is required");

  const cluster = parseClusterEnv(process.env.CLUSTER);

  const secret = process.env.ESCRO_WALLET_SECRET;
  let wallet: Keypair | null = null;
  if (secret && secret.length > 0) {
    try {
      wallet = parseSecret(secret);
    } catch (e) {
      throw new Error(
        `ESCRO_WALLET_SECRET could not be parsed as a base58 secret key or JSON byte array: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  // Exactly "1" admits: a typo such as "true" stops the server rather than silently refusing.
  const allowPrivateHosts = process.env.ESCRO_PAY_402_ALLOW_PRIVATE_HOSTS;
  if (allowPrivateHosts !== undefined && allowPrivateHosts !== "" && allowPrivateHosts !== "1") {
    throw new Error(
      `ESCRO_PAY_402_ALLOW_PRIVATE_HOSTS must be 1 or unset: ${JSON.stringify(allowPrivateHosts)}`,
    );
  }
  const base = {
    apiUrl,
    rpcUrl,
    cluster,
    wallet,
    chainRead: true,
    ...(allowPrivateHosts === "1" && { pay402AllowPrivateHosts: true }),
  };

  const cap = process.env.ESCRO_SPEND_CAP_USDC;
  if (cap === undefined || cap === "") return base;
  let spendCapMicroUsdc: number;
  try {
    spendCapMicroUsdc = parseUsdc(cap);
  } catch (err) {
    throw new Error(
      `ESCRO_SPEND_CAP_USDC must be a USDC amount such as "50" or "12.5" (at most six decimals): ${cap}`,
      { cause: err },
    );
  }
  return { ...base, spendCapMicroUsdc };
}
