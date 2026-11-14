// The MCP worker's service: reads escro.mcp.json and hands the rest to `loadMcpService`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type EscroConfig } from "../escro.config.js";
import { usdcToMicro } from "./float-cap.js";
import { connectMcp, loadMcpService } from "./mcp-adapter.js";
import type { BotService } from "./serve402.js";
import type { Storage } from "./storage.js";

// Project root from dist/src/service.js -> ../../
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function loadService(config: EscroConfig, storage: Storage): Promise<BotService> {
  // The default service's signature; an MCP adapter uploads nothing itself.
  void storage;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "escro.mcp.json"), "utf8"));
  } catch (err) {
    return {
      idle:
        `Could not read escro.mcp.json (${err instanceof Error ? err.message : String(err)}): ` +
        "restore it from a --from-mcp scaffold.",
    };
  }
  return loadMcpService({
    projectRoot: PROJECT_ROOT,
    manifest,
    config,
    parseConfig: (raw) => ConfigSchema.parse(raw),
    usdcToMicro,
    connect: connectMcp,
    logger: console,
  });
}
