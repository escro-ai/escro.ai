import type { z } from "zod";
import type { ApiClient, Escro, EscrowState } from "@escro/sdk";

export declare const listEscrowsSchema: Record<string, z.ZodType>;
export declare const getEscrowSchema: Record<string, z.ZodType>;
export declare const listBotsSchema: Record<string, z.ZodType>;
export declare const getReputationSchema: Record<string, z.ZodType>;
export declare const verifyEscrowOnchainSchema: Record<string, z.ZodType>;
export declare const createEscrowSchema: Record<string, z.ZodType>;
export declare const claimTaskSchema: Record<string, z.ZodType>;
export declare const submitDeliverableSchema: Record<string, z.ZodType>;
export declare const releasePaymentSchema: Record<string, z.ZodType>;
export declare const cancelEscrowSchema: Record<string, z.ZodType>;
export declare const raiseDisputeSchema: Record<string, z.ZodType>;
export declare const pay402Schema: Record<string, z.ZodType>;

/** A tool result: one text block holding the JSON-encoded value (bigints as strings). */
export interface ToolResult {
  content: { type: "text"; text: string }[];
}

export interface ReadHandlers {
  list_escrows: (args: {
    state?: EscrowState | undefined;
    assignedTo?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    mine?: boolean | undefined;
  }) => Promise<ToolResult>;
  get_escrow: (args: { address: string }) => Promise<ToolResult>;
  list_bots: (args: {
    capability?: string | undefined;
    role?: "worker" | "buyer" | "both" | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }) => Promise<ToolResult>;
  get_reputation: (args: { wallet: string }) => Promise<ToolResult>;
}

export interface WriteHandlers {
  create_escrow: (args: {
    taskSpec: unknown;
    amountUsdc: number;
    deadlineUnix: number;
    assignedWorker: string;
  }) => Promise<ToolResult>;
  claim_task: (args: { address: string }) => Promise<ToolResult>;
  submit_deliverable: (args: {
    address: string;
    contentHash: string;
    proofUri?: string | undefined;
  }) => Promise<ToolResult>;
  release_payment: (args: { address: string }) => Promise<ToolResult>;
  cancel_escrow: (args: { address: string }) => Promise<ToolResult>;
  raise_dispute: (args: {
    address: string;
    reason: string;
    evidence?: string | undefined;
  }) => Promise<ToolResult>;
  pay_402: (args: {
    url: string;
    to: string;
    amountMicroUsdc: number;
    method?: "GET" | "POST" | undefined;
    contentType?: string | undefined;
    body?: string | undefined;
    maxDeadlineSeconds?: number | undefined;
  }) => Promise<ToolResult>;
}

export interface ChainReadHandlers {
  verify_escrow_onchain: (args: {
    address?: string | undefined;
    buyer?: string | undefined;
    taskId?: string | undefined;
  }) => Promise<ToolResult>;
}

export interface ReadHandlerOptions {
  /** The server wallet's base-58 address; absent, list_escrows refuses `mine`. */
  wallet?: string;
}
export function makeReadHandlers(api: ApiClient, options?: ReadHandlerOptions): ReadHandlers;
export function makeChainReadHandlers(env: {
  cluster: "devnet" | "mainnet";
  rpcUrl: string;
}): ChainReadHandlers;
export interface WriteHandlerOptions {
  /**
   * The cluster the Escro targets; absent, pay_402 applies mainnet's https rule, and its policy
   * admits only mainnet entries, so a devnet 402 is refused with nothing funded.
   */
  cluster?: "devnet" | "mainnet";
  /** Admit loopback, link-local and private hosts in pay_402; absent, refused. */
  allowPrivateHosts?: boolean;
}
export function makeWriteHandlers(escro: Escro, options?: WriteHandlerOptions): WriteHandlers;
