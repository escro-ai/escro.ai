/**
 * Shared Bittensor-subnet ServiceAdapter core. SN56 (gradients), SN17 (404gen) and
 * SN51 (lium) are three Bittensor-shaped adapters that swap a per-task USDC budget
 * into TAO internally, pay subnet miners in TAO, collect a deliverable, and return a
 * currency-free `ServiceResult`. This module owns what they share: the branded `Tao`
 * type (which exists ONLY in the adapter layer and can never reach a `ServiceResult`
 * or the escrow submit path, a compile-time guarantee),
 * the USDC->TAO swap / subnet-call / pin ports, the shared default ports, and the
 * `execute` skeleton. Each adapter supplies its own subnet id, capabilities, budget,
 * demo logic and default-port wiring, then delegates `execute` to
 * {@link createBittensorSubnetAdapter}. Ridges (USD-billed, no TAO) is deliberately
 * NOT part of this core.
 */
import { createHash } from "crypto";

import type { TaskSpec } from "@escro/shared";

import type { ServiceAdapter, ServiceResult } from "../../adapter.js";

/**
 * Amount denominated in TAO (Bittensor's token). Branded so it cannot be assigned to
 * or from a plain `number` by accident and (the point of the brand) so it can never
 * appear in a `ServiceResult` or the escrow submit path: those types have no field of
 * this type. TAO exists ONLY inside the Bittensor adapter layer.
 */
export type Tao = number & { readonly __brand: "TAO" };

/** Construct a {@link Tao} amount from a plain number. Adapter-internal use only. */
export function tao(amount: number): Tao {
  return amount as Tao;
}

/** Swap a microUSDC budget into TAO. Real workers route this through a DEX (e.g. Jupiter). */
export type UsdcToTaoSwap = (microUsdc: number) => Promise<Tao>;

/**
 * Pay subnet miners `budget` TAO to run `spec`; resolve with the raw deliverable. The
 * single shared port shape across every Bittensor adapter (a GPU-rental call is a paid
 * subnet call too; lium re-exports this as `RunGpuJob`).
 */
export type SubnetCall = (spec: TaskSpec, budget: Tao) => Promise<string | Buffer>;

/** Pin `content` and resolve with a content-addressed proof URI (ipfs://, ar://). */
export type PinContent = (content: string | Buffer) => Promise<string>;

/** SHA-256 hex digest of a deliverable. */
export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// Nominal reference rate: microUSDC -> TAO. Only the stub swap cares about the exact value.
export const REFERENCE_MICRO_USDC_PER_TAO = 300_000_000;

/** Default fixed-rate reference swap, shared by every reference Bittensor adapter. */
export const defaultSwap: UsdcToTaoSwap = (microUsdc) =>
  Promise.resolve(tao(microUsdc / REFERENCE_MICRO_USDC_PER_TAO));

/** Default deterministic `ipfs://` placeholder pin, shared by every reference adapter. */
export const defaultPin: PinContent = (content) =>
  Promise.resolve(`ipfs://placeholder-${sha256Hex(content).slice(0, 16)}`);

/** Fully-resolved ports and identity for {@link createBittensorSubnetAdapter}. */
export interface BittensorSubnetAdapterConfig {
  /** Subnet identifier (e.g. "sn56"); forms the adapter id `bittensor:<subnet>`. */
  subnet: string;
  /** Advertised capabilities for EscroBots discovery. */
  capabilities: string[];
  /** microUSDC allocated to a single task before converting to TAO (internal budgeting). */
  taskBudgetMicroUsdc: number;
  /** USDC->TAO swap port. */
  swap: UsdcToTaoSwap;
  /** Subnet-call port (pays the subnet in TAO and returns the deliverable). */
  callSubnet: SubnetCall;
  /** Pinning port. */
  pin: PinContent;
  /** Health-check port. */
  checkHealth: () => Promise<boolean>;
}

/**
 * Build a Bittensor-subnet {@link ServiceAdapter} from fully-resolved ports. The
 * execute skeleton: swap the USDC budget into TAO (internal, never surfaced), pay the
 * subnet in TAO and collect the deliverable, then hash and pin. The recorded
 * `ServiceResult` is currency-free (no TAO field). Every reference TAO adapter resolves
 * its own defaults and delegates here.
 */
export function createBittensorSubnetAdapter(config: BittensorSubnetAdapterConfig): ServiceAdapter {
  const id = `bittensor:${config.subnet}`;
  return {
    id,
    capabilities: config.capabilities,
    healthCheck: config.checkHealth,
    async execute(spec: TaskSpec): Promise<ServiceResult> {
      // 1. Swap the USDC budget into TAO (internal, never surfaced).
      const budgetTao = await config.swap(config.taskBudgetMicroUsdc);
      // 2. Pay subnet miners in TAO and collect the deliverable.
      const content = await config.callSubnet(spec, budgetTao);
      // 3. Hash and pin. The result the escrow records is currency-free.
      const contentHash = sha256Hex(content);
      const proofUri = await config.pin(content);
      return {
        content,
        contentHash,
        proofUri,
        metadata: { adapter: id, subnet: config.subnet },
      };
    },
  };
}
