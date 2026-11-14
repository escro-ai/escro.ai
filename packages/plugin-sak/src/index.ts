import type { Keypair } from "@solana/web3.js";
import { Escro, type EscroOptions, type SpendCap, type X402SpendCap } from "@escro/sdk";
import { getApiUrl, getPublicRpcUrl, parseClusterEnv } from "@escro/shared";

import { buildActions, type EscroActionName } from "./actions.js";
import { EscroPluginError } from "./errors.js";
import type { Action, Handler, SakAgent } from "./sak.js";

export { EscroPluginError } from "./errors.js";
export type { EscroActionName } from "./actions.js";
export type { Plugin, Action, ActionExample, Handler, SakAgent } from "./sak.js";

export interface EscroSakPluginOptions {
  /** The agent wallet's own keypair; passed only to the SDK, which alone signs. */
  wallet: Keypair;
  /** Required; a missing cluster never defaults to devnet. */
  cluster: EscroOptions["cluster"];
  /** Passed through unchanged; the SDK refuses a mainnet commission without it. */
  spendCap?: SpendCap;
  /** Passed through unchanged; the SDK refuses a mainnet `exact` payment without it. */
  x402SpendCap?: X402SpendCap;
  /** Defaults to the cluster's public Escro API. */
  apiUrl?: string;
  /** Defaults to the cluster's public RPC endpoint. */
  rpcUrl?: string;
  /**
   * Lets escro_pay_402 pay a URL whose host is a loopback, link-local or private address (a local
   * worker). Off by default. On mainnet a public host is still paid only over https:.
   */
  allowPrivateHosts?: boolean;
}

export interface EscroSakPlugin {
  name: "escro";
  methods: Record<EscroActionName, Handler>;
  actions: Action[];
  initialize(agent: SakAgent): void;
}

const SECRET_KEY_BYTES = 64;

/** The address of a value that may not be the wallet its type says; null when it has none. */
function addressOf(wallet: unknown): string | null {
  const key = (wallet as { publicKey?: { toBase58?: () => string } | null } | null | undefined)
    ?.publicKey;
  return typeof key?.toBase58 === "function" ? key.toBase58() : null;
}

/** The message names no field's value: what is refused here may be key material. */
function assertLocalKeypair(wallet: unknown): void {
  const secretKey = (wallet as { secretKey?: unknown } | null | undefined)?.secretKey;
  if (
    addressOf(wallet) === null ||
    !(secretKey instanceof Uint8Array) ||
    secretKey.length !== SECRET_KEY_BYTES
  ) {
    throw new EscroPluginError(
      "wallet must be a Keypair holding its 64-byte secret key; a wallet with no local key is not supported.",
    );
  }
}

/** Strict, so a typo ("1", "true") fails here rather than leaving the guard on or off unseen. */
function allowPrivateHostsOf(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new EscroPluginError("allowPrivateHosts must be true, false or absent.");
  }
  return raw;
}

function clusterOf(raw: unknown): EscroOptions["cluster"] {
  const refusal = 'cluster is required and must be "devnet" or "mainnet".';
  if (typeof raw !== "string" || raw === "") throw new EscroPluginError(refusal);
  try {
    return parseClusterEnv(raw);
  } catch (err) {
    throw new EscroPluginError(refusal, { cause: err });
  }
}

/**
 * The Solana Agent Kit plugin: `agent.use(createEscroPlugin({ wallet, cluster, ... }))`.
 *
 * The keypair lives only in this closure and the SDK client, so no dump of the plugin can show it.
 */
export function createEscroPlugin(options: EscroSakPluginOptions): EscroSakPlugin {
  const { wallet, apiUrl, rpcUrl, spendCap, x402SpendCap } = options;
  assertLocalKeypair(wallet);
  const cluster = clusterOf(options.cluster);
  const allowPrivateHosts = allowPrivateHostsOf(options.allowPrivateHosts);

  let client: Escro | undefined;
  const clientOf = (): Escro => {
    if (client === undefined) {
      throw new EscroPluginError(
        "The Escro plugin has not been initialized for this agent: add it with agent.use(plugin).",
      );
    }
    return client;
  };

  const actions = buildActions(clientOf, { cluster, allowPrivateHosts });
  return {
    name: "escro",
    methods: Object.fromEntries(actions.map((a) => [a.name, a.handler])) as Record<
      EscroActionName,
      Handler
    >,
    actions,
    initialize(agent: SakAgent): void {
      const own = wallet.publicKey.toBase58();
      const agentAddress = addressOf((agent as { wallet?: unknown }).wallet);
      if (agentAddress === null) {
        throw new EscroPluginError(
          `The agent's wallet has no public key to compare with the keypair ${own}.`,
        );
      }
      if (agentAddress !== own) {
        throw new EscroPluginError(
          `The keypair ${own} is not the agent's wallet ${agentAddress}; the plugin signs only as the agent's own wallet.`,
        );
      }
      client ??= new Escro({
        cluster,
        wallet,
        rpcUrl: rpcUrl ?? getPublicRpcUrl(cluster),
        apiUrl: apiUrl ?? getApiUrl(cluster),
        ...(spendCap !== undefined && { spendCap }),
        ...(x402SpendCap !== undefined && { x402SpendCap }),
      });
    },
  };
}
