import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Escro, paramsHash, parseUsdc } from "@escro/sdk";
import type { TaskSpec } from "@escro/sdk";
import { Keypair } from "@solana/web3.js";
import config from "../escro.config.js";
import { runBuyerCancelPass, runBuyerCreatePass, runBuyerOnce, type BuyerJob } from "./buyer.js";
import { hireOver402, hireSpendCap } from "./hire.js";
import { x402SpendCapFor } from "./rails.js";
import { listWorkerClaims, pickWorker } from "./worker-picker.js";
import { review } from "./review.js";
import { createTelemetry } from "./telemetry.js";

// Project root from dist/src/bot.js -> ../../
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WALLET_PATH = join(PROJECT_ROOT, "wallet", "keypair.json");
// A pass makes two single-page list reads (SUBMITTED, then FUNDED). The API allows 6 GET
// /v1/escrows requests per minute per IP, and a kit worker on the same address with its 402 menu
// on makes 4 a minute, so this buyer keeps to 2: one pass a minute. A shorter interval, or a
// second page, makes the buyer or the worker beside it lose a pass to a 429.
const POLL_INTERVAL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ` (<code>)` for an error carrying a string `code` (an EscroError), else "". */
function errorCodeOf(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) return "";
  return typeof err.code === "string" ? ` (${err.code})` : "";
}

function loadWallet(): Keypair {
  const bytes = JSON.parse(readFileSync(WALLET_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/** Assemble the configured job for `assignedWorker` into a full escrow request. */
function buildJob(assignedWorker: string): BuyerJob {
  const taskSpec: TaskSpec = {
    version: "1.0.0",
    taskType: config.job.taskType,
    description: config.job.description,
    acceptanceCriteria: config.job.acceptanceCriteria,
    deliverableFormat: { type: "json" },
    metadata: {},
  };
  return {
    assignedWorker,
    amountUsdc: config.job.amountUsdc,
    taskSpec,
    deadlineUnix: Math.floor(Date.now() / 1000) + config.job.deadlineSeconds,
  };
}

/**
 * Resolve which worker to hire: a config-pinned wallet takes priority; otherwise,
 * if a capability is configured, discover one from EscroBots. Returns "" when no
 * worker is available (review-only mode). Discovery surfaces a registry CLAIM: it
 * is verified for authorship only, never for quality; review.ts is the judge.
 */
async function resolveWorker(client: Escro): Promise<string> {
  if (config.worker !== "") return config.worker;
  if (config.capability === undefined || config.capability === "") return "";

  const candidates = await listWorkerClaims(client, config.capability);
  const picked = pickWorker(candidates);
  if (picked === null) {
    console.log(
      `No worker found in EscroBots for "${config.capability}". ` +
        "Pin config.worker to a wallet, or try again once one registers.",
    );
    return "";
  }
  console.log(
    `Discovered a worker in EscroBots for "${config.capability}": ${picked.descriptor.wallet} ` +
      `(a self-reported claim; signature valid: ${String(picked.signatureValid)}). ` +
      "Your review.ts remains the judge of the delivered work.",
  );
  return picked.descriptor.wallet;
}

export async function run(): Promise<void> {
  // Anonymous funnel: started -> worker_hired -> escrow_created -> settled. The
  // opaque runId is read from .escro/session.json (written at scaffold); set
  // telemetry:false in escro.config.ts to opt out.
  const telemetry = createTelemetry({
    path: "buyer",
    enabled: config.telemetry,
    projectRoot: PROJECT_ROOT,
  });
  telemetry.stage("started");

  console.log(`${config.name} is live (buyer, ${config.network}).`);
  // The cap is printed on every start, so the operator always sees the spend limit.
  console.log(
    config.spendCapUsdc !== undefined
      ? `Spend cap: ${String(config.spendCapUsdc)} USDC of amount plus fee across open escrows (enforced before every escrow).`
      : "No spend cap (devnet). A mainnet buyer must set spendCapUsdc.",
  );
  console.log(
    config.rails.includes("x402")
      ? `x402 spend cap: ${String(config.x402SpendCapUsdc)} USDC per process run; a restart resets it.`
      : "x402 rail off: pay() over x402 is refused.",
  );
  const reviewPolicy = review({
    cluster: config.network,
    expectedSha256: config.review.expectedSha256,
    allowPrivateHosts: config.review.allowPrivateHosts,
    maxDeliveryBytes: config.review.maxDeliveryBytes,
  });
  console.log(`Review policy: ${reviewPolicy.name}.`);
  const expectedSha256 = config.review.expectedSha256;
  if (reviewPolicy.name === "hash-matches" && expectedSha256 === undefined) {
    console.log(
      "This buyer holds every delivery, and the 24h timeout then pays the worker: set " +
        "review.expectedSha256 in escro.config.ts, or choose another review in src/review.ts.",
    );
  }

  const rpcUrl = process.env.ESCRO_RPC_URL;
  const apiUrl = process.env.ESCRO_API_URL;
  if (rpcUrl === undefined || apiUrl === undefined || rpcUrl === "" || apiUrl === "") {
    console.log(
      "Set ESCRO_RPC_URL and ESCRO_API_URL (see .env.example) to start hiring. Idle for now.",
    );
    return;
  }

  const hire = config.hire402;
  const spendCap = hireSpendCap(config.spendCapUsdc);
  const client = new Escro({
    cluster: config.network,
    rpcUrl,
    apiUrl,
    wallet: loadWallet(),
    ...(spendCap !== undefined && { spendCap }),
    x402SpendCap: x402SpendCapFor(config.rails, config.x402SpendCapUsdc),
  });

  // Raise the configured job once at startup against the resolved worker: a
  // config-pinned wallet, or one discovered from EscroBots by capability.
  // Creation is intent-driven (a real bot drives it from its own job queue). The
  // spend cap, when set, is the SDK's: every create, here or through the 402,
  // counts amount plus fee against this wallet's open escrows before any tx.
  // runBuyerCreatePass stamps `worker_hired` when a worker is resolved. With
  // hire402 on, the worker's 402 funds the job instead.
  try {
    if (hire.enabled) {
      await hireOver402(
        client,
        {
          url: hire.url,
          worker: config.worker,
          amountMicroUsdc: parseUsdc(String(config.job.amountUsdc)),
          deadlineSeconds: config.job.deadlineSeconds,
          cluster: config.network,
          method: hire.method,
          ...(hire.input !== undefined && { input: hire.input }),
          ...(expectedSha256 !== undefined && {
            acceptance: {
              name: "hash-matches",
              paramsHash: paramsHash({ sha256: expectedSha256 }),
            },
          }),
        },
        { telemetry },
      );
    } else {
      await runBuyerCreatePass(client, () => resolveWorker(client), buildJob, { telemetry });
    }
  } catch (err) {
    console.error(`[buyer] Could not create the job${errorCodeOf(err)}: ${errorMessageOf(err)}`);
  }

  console.log(
    "Polling SUBMITTED escrows to review and unclaimed expired ones to cancel... (Ctrl-C to stop)",
  );
  for (;;) {
    try {
      await runBuyerOnce(client, reviewPolicy, { telemetry });
    } catch (err) {
      console.error(`[buyer] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await runBuyerCancelPass(client);
    } catch (err) {
      console.error(
        `[buyer] cancel pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

run().catch((err: unknown) => {
  console.error("[buyer] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
