import type { Keypair } from "@solana/web3.js";

export interface McpEnv {
  apiUrl: string;
  rpcUrl: string;
  /** Solana cluster the SDK targets for program ID + USDC mint. */
  cluster: "devnet" | "mainnet";
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
export function loadEnv(): McpEnv;
