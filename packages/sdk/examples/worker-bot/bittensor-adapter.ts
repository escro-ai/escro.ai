/**
 * Bittensor ServiceAdapter: the reference `ServiceAdapter` implementation.
 *
 * A Worker Bot wraps a Bittensor subnet (default: Gradients SN56) behind the
 * `ServiceAdapter` interface exported from `@escro/sdk`. The adapter owns the
 * USDC->TAO conversion internally: it swaps a
 * per-task USDC budget into TAO, pays subnet miners in TAO, collects the
 * deliverable, and returns a currency-free `ServiceResult`. The Buyer and the
 * escrow contract only ever see USDC; no TAO-typed value crosses this boundary
 * into SDK core (the branded `Tao` type keeps it out at compile time).
 *
 * The swap, subnet call, and pinning are injectable ports so the reference runs
 * (and is tested) without a live DEX, subnet, or IPFS node. A production worker
 * supplies real implementations (Jupiter, the subnet dendrite, Pinata/Arweave).
 */
import { createHash } from "crypto";

import type { TaskSpec } from "@escro/shared";

import type { ServiceAdapter, ServiceResult } from "../../src/index.js";

/**
 * Amount denominated in TAO (Bittensor's token). Branded so it cannot be assigned
 * to or from a plain `number` by accident and (the point of the brand) so it can
 * never appear in a `ServiceResult` or the escrow submit path: those types have no
 * field of this type. TAO exists ONLY inside this module.
 */
export type Tao = number & { readonly __brand: "TAO" };

/** Construct a {@link Tao} amount from a plain number. Adapter-internal use only. */
export function tao(amount: number): Tao {
  return amount as Tao;
}

/** Swap a μUSDC budget into TAO. Real workers route this through a DEX (e.g. Jupiter). */
export type UsdcToTaoSwap = (microUsdc: number) => Promise<Tao>;

/** Pay subnet miners `budget` TAO to execute `spec`; resolve with the raw deliverable. */
export type SubnetCall = (spec: TaskSpec, budget: Tao) => Promise<string | Buffer>;

/** Pin `content` and resolve with a content-addressed proof URI (ipfs://, ar://). */
export type PinContent = (content: string | Buffer) => Promise<string>;

/** Configuration and injectable ports for {@link createBittensorAdapter}. */
export interface BittensorAdapterConfig {
  /** Subnet identifier, e.g. "sn56" (Gradients). Forms the adapter id `bittensor:<subnet>`. */
  subnet?: string;
  /** Advertised capabilities for EscroBots discovery. */
  capabilities?: string[];
  /**
   * μUSDC the worker allocates to a single task before converting to TAO. This is
   * an internal budgeting concern; it never leaves the adapter.
   */
  taskBudgetMicroUsdc?: number;
  /** Swap port. Default: a fixed-rate stub for the reference example. */
  swap?: UsdcToTaoSwap;
  /** Subnet-call port. Default: returns a deterministic placeholder deliverable. */
  callSubnet?: SubnetCall;
  /** Pinning port. Default: returns a deterministic `ipfs://` placeholder URI. */
  pin?: PinContent;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// Reference-only stubs. A production worker replaces every one of these.
const DEFAULT_SUBNET = "sn56";
const DEFAULT_CAPABILITIES = ["llm_inference"];
const DEFAULT_TASK_BUDGET_MICRO_USDC = 5_000_000;
// Nominal reference rate: μUSDC -> TAO. Only the stub cares about the exact value.
const REFERENCE_MICRO_USDC_PER_TAO = 300_000_000;

const defaultSwap: UsdcToTaoSwap = (microUsdc) =>
  Promise.resolve(tao(microUsdc / REFERENCE_MICRO_USDC_PER_TAO));

const defaultCallSubnet: SubnetCall = (spec) =>
  Promise.resolve(
    JSON.stringify({
      taskType: spec.taskType,
      description: spec.description,
      result: "placeholder",
    }),
  );

const defaultPin: PinContent = (content) =>
  Promise.resolve(`ipfs://placeholder-${sha256Hex(content).slice(0, 16)}`);

/**
 * Build a Bittensor {@link ServiceAdapter}. Passes the `assertServiceAdapterContract`
 * harness with the default ports; supply real ports for production use.
 */
export function createBittensorAdapter(config: BittensorAdapterConfig = {}): ServiceAdapter {
  const subnet = config.subnet ?? DEFAULT_SUBNET;
  const capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
  const taskBudgetMicroUsdc = config.taskBudgetMicroUsdc ?? DEFAULT_TASK_BUDGET_MICRO_USDC;
  const swap = config.swap ?? defaultSwap;
  const callSubnet = config.callSubnet ?? defaultCallSubnet;
  const pin = config.pin ?? defaultPin;
  const checkHealth = config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true));
  const id = `bittensor:${subnet}`;

  return {
    id,
    capabilities,
    healthCheck: checkHealth,
    async execute(spec: TaskSpec): Promise<ServiceResult> {
      // 1. Swap the USDC budget into TAO (internal, never surfaced).
      const budgetTao = await swap(taskBudgetMicroUsdc);
      // 2. Pay subnet miners in TAO and collect the deliverable.
      const content = await callSubnet(spec, budgetTao);
      // 3. Hash and pin. The result the escrow records is currency-free.
      const contentHash = sha256Hex(content);
      const proofUri = await pin(content);
      return {
        content,
        contentHash,
        proofUri,
        metadata: { adapter: id, subnet },
      };
    },
  };
}
