import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const server = buildServer(env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  // stderr — stdout is reserved for the MCP JSON-RPC stream.
  console.error("[escro-mcp] fatal:", err);
  process.exit(1);
});
