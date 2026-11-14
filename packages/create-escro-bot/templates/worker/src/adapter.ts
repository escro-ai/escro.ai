import { createHash } from "node:crypto";
import {
  createGradientsAdapter,
  createRidgesAdapter,
  create404genAdapter,
  createLiumAdapter,
  createAkashAdapter,
  createRenderAdapter,
  createGensynAdapter,
  createZkmlAdapter,
} from "@escro/sdk";
import type { EscrowAccount, ServiceAdapter, ServiceResult, TaskSpec } from "@escro/sdk";
import type { AdapterId, SolanaCluster } from "../escro.types.js";
import type { Storage } from "./storage.js";

// A ServiceAdapter wraps whatever async service does the work (a Bittensor subnet,
// an Akash deployment, raw compute...). Escro never sees what is underneath and
// never sees a non-USDC token: your adapter handles any token conversion internally.
//
// The shipped adapters (Bittensor gradients/ridges/404gen/lium plus the akash,
// render, gensyn, and zkml networks) are maintained in @escro/sdk and wired below,
// so `--adapter gradients` scaffolds a working bot. "custom" (and any adapter whose
// SDK implementation has not shipped yet) uses the echo stub: a working default that
// runs end to end on localnet before you wire a real service. Fill in `execute()`
// for your chosen service.

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

// The echo stub echoes the spec description so a fresh bot runs before you wire a
// real service. Replace the body with your service call; keep `sha256Hex` (the
// on-chain integrity anchor) unless your service returns its own content hash.
const STUBS = new WeakSet<ServiceAdapter>();

function createStubAdapter(id: AdapterId): ServiceAdapter {
  const stub: ServiceAdapter = {
    id,
    capabilities: [],
    execute(spec: TaskSpec): Promise<ServiceResult> {
      // TODO: call your service here (await it) and return its output as `content`.
      const content = `stub deliverable for: ${spec.description}`;
      return Promise.resolve({
        content,
        contentHash: sha256Hex(content),
        metadata: { adapter: id, stub: true },
      });
    },
    healthCheck(): Promise<boolean> {
      return Promise.resolve(true);
    },
  };
  STUBS.add(stub);
  return stub;
}

/**
 * The quick-start spec resolver: a minimal spec naming the escrow, so a fresh bot runs on
 * devnet. A real worker gets the spec from the buyer and checks it hashes to
 * `task.taskSpecHash`; replace this in `service.ts`.
 */
export function placeholderResolveTaskSpec(task: EscrowAccount): Promise<TaskSpec> {
  return Promise.resolve({
    version: "1.0.0",
    taskType: "custom",
    description: `Escrow ${task.address}`,
    acceptanceCriteria: [{ id: "ac-1", description: "deliverable produced" }],
    deliverableFormat: { type: "json" },
    metadata: {},
  });
}

/**
 * Why the worker must not claim on `network`, or null. On mainnet the echo stub and the
 * placeholder spec would submit made-up work against a buyer's real funds.
 */
export function mainnetClaimRefusal(
  network: SolanaCluster,
  adapter: ServiceAdapter,
  resolveTaskSpec: (task: EscrowAccount) => Promise<TaskSpec>,
): string | null {
  if (network !== "mainnet") return null;
  if (STUBS.has(adapter)) {
    return "The echo stub adapter cannot work mainnet jobs: implement execute() in src/adapter.ts.";
  }
  if (resolveTaskSpec === placeholderResolveTaskSpec) {
    return "The placeholder spec resolver cannot work mainnet jobs: fetch the buyer's spec in src/service.ts.";
  }
  return null;
}

/** Uploads bytes through the kit storage and resolves to the URI the worker submits. */
type KitPin = (bytes: string | Buffer) => Promise<string>;

// Adapter-awareness seam: each reference adapter wires its shipped @escro/sdk factory
// here and pins through the kit storage with `pin`, so its `proofUri` names bytes the
// buyer can fetch (for gensyn and zkml, the bundle of the deliverable and its proof).
// An adapter built without `pin` pins to its default placeholder, and the worker then
// submits a URI that resolves to nothing. Adapters without a shipped implementation
// fall back to the echo stub, which pins nothing: the worker uploads its content.
const ADAPTER_FACTORIES: Partial<Record<AdapterId, (pin: KitPin) => ServiceAdapter>> = {
  gradients: (pin) => createGradientsAdapter({ pin }),
  ridges: (pin) => createRidgesAdapter({ pin }),
  "404gen": (pin) => create404genAdapter({ pin }),
  lium: (pin) => createLiumAdapter({ pin }),
  akash: (pin) => createAkashAdapter({ pin }),
  render: (pin) => createRenderAdapter({ pin }),
  gensyn: (pin) => createGensynAdapter({ pin }),
  zkml: (pin) => createZkmlAdapter({ pin }),
};

export function createAdapter(id: AdapterId, storage: Storage): ServiceAdapter {
  const factory = ADAPTER_FACTORIES[id];
  if (factory === undefined) return createStubAdapter(id);
  // The pin hands the storage the sha256 of the bytes it pins (for gensyn and zkml the
  // bundle's), not the deliverable's hash.
  const pin: KitPin = async (bytes) =>
    (await storage.upload({ content: bytes, contentHash: sha256Hex(bytes) })).proofUri;
  return factory(pin);
}
