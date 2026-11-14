import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { MCPAdapter } from "@langchain/mcp-adapters";
import {
  commissionPrompt,
  decideToolCall,
  DEVNET_SERVER_ENV,
  MCP_PACKAGE,
  READ_TOOLS,
  readCommissionEnv,
  SIGNING_TOOL,
  terminalAsk,
} from "./confirm.js";

const MODEL = "claude-opus-5-5";

const { walletSecret, worker } = readCommissionEnv(process.env);

const readTools: readonly string[] = READ_TOOLS;

const escro = new MCPAdapter({
  servers: {
    escro: {
      transport: "stdio",
      command: "npx",
      args: ["-y", MCP_PACKAGE],
      env: { ...DEVNET_SERVER_ENV, ESCRO_WALLET_SECRET: walletSecret },
    },
  },
  prefixToolNameWithServerName: false,
  // Runs before the call reaches the server, so no path through the graph can skip it.
  beforeToolCall: async ({ name, args }) => {
    const decision = await decideToolCall(name, args, terminalAsk);
    if (!decision.allow) throw new Error(decision.message);
  },
});

try {
  const tools = (await escro.listTools()).filter(
    (tool) => readTools.includes(tool.name) || tool.name === SIGNING_TOOL,
  );
  const model = new ChatAnthropic({ model: MODEL, maxTokens: 16000 }).bindTools(tools);

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => ({ messages: [await model.invoke(state.messages)] }))
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, ["tools", END])
    .addEdge("tools", "agent")
    .compile();

  const prompt = commissionPrompt(worker, Math.floor(Date.now() / 1000));
  const finished = await graph.invoke({ messages: [new HumanMessage(prompt)] });
  console.log(finished.messages.at(-1)?.text);
} finally {
  await escro.close();
}
