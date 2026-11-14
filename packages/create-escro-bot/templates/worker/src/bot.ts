import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Escro } from "@escro/sdk";
import { Connection, Keypair } from "@solana/web3.js";
import config from "../escro.config.js";
import { mainnetClaimRefusal } from "./adapter.js";
import { depsFromService } from "./compose.js";
import { createKit402, startServer } from "./serve402.js";
import { loadService } from "./service.js";
import { createStorage } from "./storage.js";
import { createTelemetry } from "./telemetry.js";
import { runWorkerOnce, type WorkerDeps, type WorkerLoopConfig } from "./worker.js";

// Project root from dist/src/bot.js -> ../../
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WALLET_PATH = join(PROJECT_ROOT, "wallet", "keypair.json");
// A pass makes at most four single-page list reads (IN_PROGRESS, FUNDED, and SUBMITTED and
// DISPUTED only when something is FUNDED or the 402 menu is enabled), two when nothing is FUNDED
// and the menu is off. The menu's own requests make no list read. One pass a minute stays
// under the API's limit of 6 GET /v1/escrows requests per minute with room for two extra pages;
// a shorter interval lets two passes share one rate-limit window and draw a 429.
const POLL_INTERVAL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadWallet(): Keypair {
  const bytes = JSON.parse(readFileSync(WALLET_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export async function run(): Promise<void> {
  // Anonymous funnel: the worker's runtime stage is `started`. Its registered ->
  // discoverable stages are stamped by the scaffolder (create-escro-bot) after
  // EscroBots registration. Set telemetry:false in escro.config.ts to opt out.
  createTelemetry({
    path: "worker",
    enabled: config.telemetry,
    projectRoot: PROJECT_ROOT,
  }).stage("started");

  const storage = createStorage(config.storage);
  console.log(`${config.name} is live (worker, ${config.network}).`);
  console.log(
    `Working-capital bound: ${String(config.maxConcurrentFloatUsdc)} USDC ` +
      `(refuses new jobs beyond it). Deliverable retention: ${String(config.storage.retentionDays)} days.`,
  );

  const rpcUrl = process.env.ESCRO_RPC_URL;
  const apiUrl = process.env.ESCRO_API_URL;
  if (rpcUrl === undefined || apiUrl === undefined || rpcUrl === "" || apiUrl === "") {
    console.log(
      "Set ESCRO_RPC_URL and ESCRO_API_URL (see .env.example) to start working. Idle for now.",
    );
    return;
  }

  // Fail fast, same spirit as the deadline and float guards: a worker with no
  // upload target cannot deliver, so refuse to start the claim loop rather than
  // claim a job and strand it (claimed-but-not-submitted) until the 24h backstop.
  if (config.storage.endpoint === undefined) {
    console.log(
      "Set storage.endpoint in escro.config.ts (for s3-presigned your presign service, with " +
        "storage.publicBase the URL prefix buyers read deliverables from; for ipfs a pinning " +
        "endpoint) so deliverables can be uploaded before claiming. Idle for now.",
    );
    return;
  }
  if (config.storage.backend === "s3-presigned" && config.storage.publicBase === undefined) {
    console.log(
      "Set storage.publicBase in escro.config.ts to the URL prefix buyers read deliverables " +
        "from, so each deliverable gets its own proof URI before claiming. Idle for now.",
    );
    return;
  }

  const service = await loadService(config, storage);
  if ("idle" in service) {
    console.log(`${service.idle} Idle for now.`);
    return;
  }
  const { config: live } = service;
  console.log(`Adapter: ${service.adapter.id}.`);

  const refusal = mainnetClaimRefusal(live.network, service.adapter, service.resolveTaskSpec);
  if (refusal !== null) {
    console.log(`${refusal} Idle for now.`);
    return;
  }

  const wallet = loadWallet();
  const client = new Escro({ cluster: live.network, rpcUrl, apiUrl, wallet });
  const loopConfig: WorkerLoopConfig = {
    maxConcurrentFloatUsdc: live.maxConcurrentFloatUsdc,
    estimatedServiceCostUsdc: live.estimatedServiceCostUsdc,
    estimatedDurationSeconds: live.estimatedDurationSeconds,
    deadlineSafetyBufferSeconds: live.deadlineSafetyBufferSeconds,
  };
  const { workerDeps, kitInput } = depsFromService(service, {
    storage,
    client,
    payTo: wallet.publicKey.toBase58(),
    rpc: new Connection(rpcUrl, "confirmed"),
    now: () => Date.now(),
    logger: console,
  });
  const deps: WorkerDeps = { ...workerDeps };

  if (live.serve402.enabled) {
    const { menu, loopDeps } = createKit402(kitInput);
    const { host, port } = live.serve402;
    await startServer(menu, { host, port });
    console.log(`Serving the 402 menu on ${host}:${String(port)}.`);
    Object.assign(deps, loopDeps);
  }

  console.log("Polling for assigned FUNDED tasks... (Ctrl-C to stop)");
  for (;;) {
    try {
      await runWorkerOnce(client, loopConfig, deps);
    } catch (err) {
      console.error(`[worker] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

run().catch((err: unknown) => {
  console.error("[worker] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
