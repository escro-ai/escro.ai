// `npm run mcp:tools`: what the server in escro.mcp.json offers, and why each tool is or is not sellable.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcp, eligibleTools } from "./mcp-adapter.js";

// Project root from dist/src/mcp-tools.js -> ../../
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "escro.mcp.json"), "utf8")) as {
    server: string;
  };
  const caller = await connectMcp(manifest.server);
  try {
    const { eligible, excluded } = eligibleTools(await caller.listTools());
    console.log(`Eligible tools on ${manifest.server}:`);
    for (const tool of eligible) console.log(`  ${tool.name}`);
    console.log("Excluded:");
    for (const { name, reason } of excluded) console.log(`  ${name}: ${reason}`);
    console.log("Confirm a tool by adding it to tools and pricing in escro.mcp.json.");
  } finally {
    await caller.close();
  }
}

main().catch((err: unknown) => {
  console.error("[mcp:tools] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
