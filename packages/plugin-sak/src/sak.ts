/**
 * Minimal vendored type surface for `solana-agent-kit`, Apache-2.0.
 *
 * `solana-agent-kit` is provided by the host agent and declared in no dependency list; this plugin imports no runtime
 * value from it, and its dependency tree is out of proportion to a handful of erased types. Each declaration below is a consume-only structural subset of the published declarations of:
 *
 *   solana-agent-kit@2.0.10  dist/index.d.ts
 *
 * The kit spells `any` where this file spells `unknown`. A real `SolanaAgentKit` remains assignable to `SakAgent` and
 * the plugin to the kit's `Plugin`. If a later kit major changes these shapes, re-verify against its declarations.
 */
import type { z } from "zod";

/** The part of `SolanaAgentKit` this plugin reads: `BaseWallet.publicKey`, and no signing method. */
export interface SakAgent {
  wallet: { publicKey: { toBase58(): string } };
}

export type Handler = (
  agent: SakAgent,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ActionExample {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  explanation: string;
}

export interface Action {
  name: string;
  similes: string[];
  description: string;
  examples: ActionExample[][];
  schema: z.ZodType<unknown>;
  handler: Handler;
}

export interface Plugin {
  name: string;
  methods: Record<string, unknown>;
  actions: Action[];
  initialize(agent: SakAgent): void;
}
