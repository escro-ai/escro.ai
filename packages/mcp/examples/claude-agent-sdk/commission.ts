import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  commissionPrompt,
  decideToolCall,
  DEVNET_SERVER_ENV,
  MCP_PACKAGE,
  readCommissionEnv,
  terminalAsk,
} from "./confirm.js";

const MODEL = "claude-opus-5-5";

const { worker } = readCommissionEnv(process.env);

const session = query({
  prompt: commissionPrompt(worker, Math.floor(Date.now() / 1000)),
  options: {
    model: MODEL,
    // No built-in tools: without Bash or file reads the model cannot reach the wallet key in
    // this process's environment.
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    // The server inherits the wallet key from this process. It is not set in `env` below because
    // the Agent SDK puts this whole block on a command line, which `ps` can read.
    mcpServers: {
      escro: {
        type: "stdio",
        command: "npx",
        args: ["-y", MCP_PACKAGE],
        env: DEVNET_SERVER_ENV,
      },
    },
    canUseTool: async (toolName, input) => {
      const decision = await decideToolCall(toolName, input, terminalAsk);
      return decision.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: decision.message };
    },
  },
});

for await (const message of session) {
  if (message.type !== "result") continue;
  if (message.subtype === "success") {
    console.log(message.result);
  } else {
    console.error(`The agent stopped: ${message.subtype}`);
    process.exitCode = 1;
  }
}
