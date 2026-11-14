import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpEnv } from "./env.js";

/** Keep in step with package.json / server.json. */
export declare const SERVER_VERSION: "0.1.3";

export function buildServer(env: McpEnv): McpServer;
