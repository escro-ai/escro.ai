import type { SolanaCluster } from "@escro/shared";

/**
 * The single source of truth for the cluster union is `@escro/shared`
 * (`SolanaCluster`); re-exported here so the CLI never redeclares it and the
 * generated project's own copy stays in step with the protocol.
 */
export type { SolanaCluster } from "@escro/shared";

export type BotTemplate = "worker" | "buyer";

export type AdapterId =
  | "gradients"
  | "ridges"
  | "404gen"
  | "lium"
  | "akash"
  | "render"
  | "gensyn"
  | "zkml"
  | "custom";

export interface ResolvedOptions {
  name: string;
  template: BotTemplate;
  adapter: AdapterId;
  network: SolanaCluster;
  /** Spend cap in USDC; present only for a mainnet BuyerBot. */
  spendCapUsdc?: number;
  /** Anonymous funnel telemetry; absent/true = on, false = --no-telemetry opt-out. */
  telemetry?: boolean;
  /** Present when the worker wraps an MCP server (`--from-mcp`). */
  mcp?: { serverUrl: string; tools: string[] };
}

export const TEMPLATES: readonly BotTemplate[] = ["worker", "buyer"];

export const ADAPTER_IDS: readonly AdapterId[] = [
  "gradients",
  "ridges",
  "404gen",
  "lium",
  "akash",
  "render",
  "gensyn",
  "zkml",
  "custom",
];

export const NETWORKS: readonly SolanaCluster[] = ["devnet", "mainnet"];

export const DEFAULT_ADAPTER: AdapterId = "custom";

export const DEFAULT_NETWORK: SolanaCluster = "devnet";

/** The claim fields an adapter advertises in its EscroBots descriptor. */
export interface AdapterDescriptor {
  /** Filterable capability tags a buyer's worker-picker queries on. */
  capabilities: string[];
  /** The wrapped service, e.g. `"bittensor:sn56"`. */
  serviceRef: string;
  /** Human-readable pricing guidance. */
  pricingHint: string;
}

/**
 * Adapter -> the self-reported capability claim registered in EscroBots at init.
 * One entry per launch adapter. Typed as a
 * `Record<AdapterId, …>` deliberately: a new adapter that forgets to add a
 * descriptor here fails the build rather than registering a blank claim (the
 * registry requires >= 1 capability and a non-empty serviceRef). These are
 * CLAIMS the operator can refine; on-chain history is the verification.
 */
export const ADAPTER_DESCRIPTORS: Record<AdapterId, AdapterDescriptor> = {
  gradients: {
    capabilities: ["fine-tune"],
    serviceRef: "bittensor:sn56",
    pricingHint: "$10-200 per fine-tune job",
  },
  ridges: {
    capabilities: ["code-generation"],
    serviceRef: "ridges",
    pricingHint: "$5-100 per coding job",
  },
  "404gen": {
    capabilities: ["3d-generation"],
    serviceRef: "bittensor:sn17",
    pricingHint: "$5-50 per 3D asset batch",
  },
  lium: {
    capabilities: ["gpu-compute"],
    serviceRef: "bittensor:sn51",
    pricingHint: "$20-500 per GPU job",
  },
  akash: {
    capabilities: ["cloud-compute"],
    serviceRef: "akash",
    pricingHint: "$5-100 per Akash deployment",
  },
  render: {
    capabilities: ["3d-rendering", "video-rendering", "gpu-inference"],
    serviceRef: "render",
    pricingHint: "$5-200 per render or inference job",
  },
  gensyn: {
    capabilities: ["verifiable-compute"],
    serviceRef: "gensyn",
    pricingHint: "$10-300 per verifiable-compute job",
  },
  zkml: {
    capabilities: ["zk-verified-inference"],
    serviceRef: "zkml",
    pricingHint: "$5-150 per ZK-verified inference job",
  },
  custom: {
    capabilities: ["custom"],
    serviceRef: "custom",
    pricingHint: "edit escro.config.ts to set your capability and pricing",
  },
};
