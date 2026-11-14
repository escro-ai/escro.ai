// The one place a service's seams reach the kit, so `bot.ts` cannot drop one.

import type { BotService, KitMenuDeps } from "./serve402.js";
import type { Storage } from "./storage.js";
import type { WorkerClient, WorkerDeps, WorkerLogger } from "./worker.js";

/** A service that is not idling. */
export type RunnableService = Exclude<BotService, { idle: string }>;

export interface ComposeBase {
  storage: Storage;
  client: WorkerClient;
  /** The wallet `client` signs with. */
  payTo: string;
  rpc: KitMenuDeps["rpc"];
  now: () => number;
  logger: WorkerLogger;
}

/** The loop's deps and the `createKit402` input, both built from `service`. */
export function depsFromService(
  service: RunnableService,
  base: ComposeBase,
): {
  workerDeps: Pick<
    WorkerDeps,
    "adapter" | "storage" | "resolveTaskSpec" | "claimRefusal" | "executeJob"
  >;
  kitInput: Omit<KitMenuDeps, "executors" | "committed" | "menuSpecs">;
} {
  const { config, adapter, resolveTaskSpec, claimRefusal, taskSpecFor, executeJob } = service;
  const { storage } = base;
  return {
    workerDeps: {
      adapter,
      storage,
      resolveTaskSpec,
      ...(claimRefusal !== undefined && { claimRefusal }),
      ...(executeJob !== undefined && { executeJob }),
    },
    kitInput: {
      ...base,
      config,
      adapter,
      ...(taskSpecFor !== undefined && { taskSpecFor }),
      ...(executeJob !== undefined && { executeJob }),
    },
  };
}
