// What this bot runs on. Replace the resolver with your own: get the spec from the buyer and check
// it hashes to task.taskSpecHash.

import type { EscroConfig } from "../escro.config.js";
import { createAdapter, placeholderResolveTaskSpec } from "./adapter.js";
import type { BotService } from "./serve402.js";
import type { Storage } from "./storage.js";

export function loadService(config: EscroConfig, storage: Storage): Promise<BotService> {
  return Promise.resolve({
    config,
    adapter: createAdapter(config.adapter, storage),
    resolveTaskSpec: placeholderResolveTaskSpec,
  });
}
