// A Cloudflare Worker serving the 402 menu. Bindings (README.md): the operator's worker key is a Worker secret, never a
// [vars] entry. Unpublished: in a Worker project of your own, import from "@escro/x402-middleware" instead of src/.
import { Connection, Keypair } from "@solana/web3.js";
import { Escro, type TaskSpec } from "@escro/sdk";

import { createX402Menu, type MenuRequest, type X402Menu } from "../../src/index.js";

interface Env {
  CLUSTER: "devnet" | "mainnet";
  PUBLIC_URL: string;
  RPC_URL: string;
  API_URL: string;
  WORKER_SECRET_KEY: string;
}

export function createHandler(deps: {
  menu: X402Menu;
  fallback(request: Request): Promise<Response>;
}): (request: Request) => Promise<Response> {
  return async (request) => (await deps.menu.fetch(request)) ?? deps.fallback(request);
}

/** The job a request asks for: the request is the specification, so a paid request re-derives the same hash. */
function summaryTask(request: MenuRequest): TaskSpec {
  return {
    version: "1.0.0",
    taskType: "summarization",
    description: "Summarise the document in the request body in at most 300 words.",
    acceptanceCriteria: [{ id: "length", description: "At most 300 words.", required: true }],
    deliverableFormat: { type: "text", mimeType: "text/markdown" },
    metadata: { input: request.body === undefined ? null : request.body },
  };
}

function buildHandler(env: Env): (request: Request) => Promise<Response> {
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(env.WORKER_SECRET_KEY) as number[]),
  );
  const menu = createX402Menu({
    cluster: env.CLUSTER,
    payTo: wallet.publicKey.toBase58(),
    escro: new Escro({ cluster: env.CLUSTER, rpcUrl: env.RPC_URL, apiUrl: env.API_URL, wallet }),
    rpc: new Connection(env.RPC_URL, "confirmed"),
    publicUrl: env.PUBLIC_URL,
    routes: [
      {
        method: "POST",
        path: "/v1/summarise",
        priceMicroUsdc: 25_000_000n,
        workSeconds: 3_600,
        taskSpec: summaryTask,
        // Hand the job to your queue here; this handler returns before the work is done.
        onClaimed: () => undefined,
      },
    ],
  });
  return createHandler({
    menu,
    fallback: () => Promise.resolve(new Response("Not found", { status: 404 })),
  });
}

// One menu per isolate: its replay and job stores live in memory, and the fee cache across requests.
let handler: ((request: Request) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    handler ??= buildHandler(env);
    return handler(request);
  },
};
