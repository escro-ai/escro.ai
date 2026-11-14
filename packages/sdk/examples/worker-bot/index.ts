/**
 * WorkerBot — reference implementation of the escrow worker flow.
 *
 * This bot:
 *   1. Reads the escrow PDA from a file (shared off-platform by the buyer).
 *   2. Polls getMyTasks() until FUNDED tasks assigned to this wallet appear.
 *   3. Skips tasks that are too close to their deadline.
 *   4. Claims each eligible task, executes it via a ServiceAdapter, and submits
 *      the adapter's deliverable.
 *   5. Handles errors gracefully — never leaves a claimed escrow in limbo.
 *
 * The work itself lives behind a ServiceAdapter (default: the Bittensor adapter),
 * so this flow is agnostic to what produced the deliverable and never sees a
 * non-USDC token; the adapter handles any conversion internally.
 *
 * Usage: see README.md
 */

import * as fs from "fs";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  Escro,
  EscrowTimeoutError,
  EscrowStateError,
  serviceResultToSubmitParams,
} from "../../src/index.js";
import type { ServiceAdapter } from "../../src/index.js";
import { EscrowState } from "@escro/shared";
import type { EscrowAccount, TaskSpec } from "@escro/shared";
import { createBittensorAdapter } from "./bittensor-adapter.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkerBotOptions {
  /** Path to read the escrow PDA written by the BuyerBot. */
  escrowIdFile: string;
  /**
   * How long (ms) to wait for assigned tasks to appear before giving up.
   * @default 120_000 (2 minutes)
   */
  taskPollTimeoutMs?: number;
  /**
   * How many seconds before a task's deadline the worker should refuse it.
   * @default 300 (5 minutes)
   */
  deadlineBufferSeconds?: number;
  /**
   * The ServiceAdapter that executes claimed tasks.
   * @default the Bittensor adapter (`createBittensorAdapter()`)
   */
  adapter?: ServiceAdapter;
  /**
   * Resolve the {@link TaskSpec} for a claimed escrow. A production worker gets the
   * spec JSON from the buyer and works from it only if it hashes to `task.taskSpecHash`
   * (Escro stores the hash, never the body); the reference default returns a minimal
   * spec so the example runs without one.
   */
  resolveTaskSpec?: (task: EscrowAccount) => Promise<TaskSpec>;
  /**
   * Decide whether there is enough time left to safely work on a task. Injectable
   * for testing; defaults to {@link isDeadlineSafe}.
   */
  isDeadlineSafe?: (task: EscrowAccount, bufferSeconds: number) => boolean;
}

// ── Deadline guard ───────────────────────────────────────────────────────────

/**
 * Returns true if there is enough time left to safely work on this task:
 * at least `bufferSeconds` remain before the escrow's on-chain deadline. The
 * worker refuses tasks it cannot finish, so it never strands buyer funds against
 * the 24h timeout backstop. The boundary is inclusive (remaining === buffer is
 * safe). `nowMs` is injectable for deterministic tests.
 */
export function isDeadlineSafe(
  task: EscrowAccount,
  bufferSeconds: number,
  nowMs = Date.now(),
): boolean {
  const secondsRemaining = task.deadline - nowMs / 1000;
  return secondsRemaining >= bufferSeconds;
}

// ── TaskSpec resolution ──────────────────────────────────────────────────────

/**
 * Default TaskSpec resolver for the reference bot.
 *
 * A production worker gets the TaskSpec JSON from the buyer, checks it hashes to
 * `task.taskSpecHash`, and passes it to the adapter. `task.taskSpecUri` is a label
 * for that hash, not a fetchable ID. The reference default returns a minimal spec
 * naming the hash so the example runs without a buyer-shared spec.
 */
export async function defaultResolveTaskSpec(task: EscrowAccount): Promise<TaskSpec> {
  console.log(`[WorkerBot]   Task spec hash: ${task.taskSpecHash}`);
  // TODO: get the TaskSpec JSON from the buyer, check it hashes to task.taskSpecHash, and return it.
  return {
    version: "1.0.0",
    taskType: "custom",
    description: `Escrow ${task.address} (spec hash ${task.taskSpecHash})`,
    acceptanceCriteria: [{ id: "ac-1", description: "deliverable produced" }],
    deliverableFormat: { type: "json" },
    metadata: {},
  };
}

// ── File reading with retry ──────────────────────────────────────────────────

async function waitForFile(filePath: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8").trim();
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${filePath} to be written`);
    }
    await sleep(2_000);
  }
}

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Run the full worker-bot flow.
 * Exported so it can be called from tests and the E2E script.
 */
export async function runWorkerBot(client: Escro, opts: WorkerBotOptions): Promise<void> {
  const {
    escrowIdFile,
    taskPollTimeoutMs = 120_000,
    deadlineBufferSeconds = 300,
    adapter = createBittensorAdapter(),
    resolveTaskSpec = defaultResolveTaskSpec,
    isDeadlineSafe: deadlineSafe = isDeadlineSafe,
  } = opts;

  // ── Step 1: Read escrow PDA from file ────────────────────────────────────

  console.log(`[WorkerBot] Waiting for escrow ID at ${escrowIdFile}...`);
  const escrowPda = await waitForFile(escrowIdFile);
  console.log(`[WorkerBot] Got escrow PDA: ${escrowPda}`);

  // ── Step 2: Poll for assigned tasks in FUNDED state ──────────────────────

  console.log("[WorkerBot] Polling for assigned FUNDED tasks...");

  let tasks: EscrowAccount[];
  try {
    const funded = await client.getMyTasks([EscrowState.FUNDED], {
      poll: true,
      timeoutMs: taskPollTimeoutMs,
    });
    tasks = funded.items;
  } catch (err) {
    if (err instanceof EscrowTimeoutError) {
      console.log("[WorkerBot] No assigned tasks found within timeout. Nothing to do.");
      return;
    }
    throw err;
  }

  console.log(`[WorkerBot] Found ${tasks.length} task(s).`);

  // ── Step 3: Process each task ─────────────────────────────────────────────

  for (const task of tasks) {
    console.log(`[WorkerBot] Processing task: ${task.address}`);

    // Deadline check
    if (!deadlineSafe(task, deadlineBufferSeconds)) {
      console.log(`[WorkerBot]   Skipping — less than ${deadlineBufferSeconds}s remaining.`);
      continue;
    }

    let claimed = false;

    try {
      // ── Step 3a: Claim the task ─────────────────────────────────────────

      console.log("[WorkerBot]   Claiming task...");
      const claimSig = await client.claimTask(task.address);
      claimed = true;
      console.log(`[WorkerBot]   Claimed. Tx: ${claimSig}`);

      // ── Step 3b: Execute the task via the ServiceAdapter ────────────────

      console.log(`[WorkerBot]   Executing via adapter ${adapter.id}...`);
      const spec = await resolveTaskSpec(task);
      const result = await adapter.execute(spec);
      console.log(`[WorkerBot]   Execution complete. Content hash: ${result.contentHash}`);
      if (result.proofUri !== undefined) {
        console.log(`[WorkerBot]   Proof URI: ${result.proofUri}`);
      }

      // ── Step 3c: Submit deliverable ─────────────────────────────────────

      console.log("[WorkerBot]   Submitting deliverable...");
      const submitSig = await client.submitDeliverable(
        task.address,
        serviceResultToSubmitParams(result),
      );
      console.log(`[WorkerBot]   Submitted. Tx: ${submitSig}`);
    } catch (err) {
      if (err instanceof EscrowStateError) {
        // Task was already claimed by another worker, or state changed unexpectedly.
        console.warn(`[WorkerBot]   State conflict on ${task.address}: ${(err as Error).message}`);
        continue;
      }

      // If we claimed but failed to submit, log a clear warning so a human can
      // intervene. Re-throw for unexpected errors.
      if (claimed) {
        console.error(
          `[WorkerBot]   ERROR: task ${task.address} was claimed but deliverable submission failed.`,
        );
        console.error(
          `[WorkerBot]   WARNING: escrow may be stuck — manual intervention needed at ${task.address}`,
        );
        console.error(`[WorkerBot]   Cause: ${(err as Error).message}`);
        // Continue to next task rather than crashing the bot entirely.
        continue;
      }

      throw err;
    }
  }

  console.log("[WorkerBot] All tasks processed.");
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
  const apiUrl = process.env.API_URL ?? "http://localhost:3000";
  const keypairEnv = process.env.WALLET_KEYPAIR;
  const escrowIdFile = process.env.ESCROW_ID_FILE ?? "/tmp/escro-e2e-escrow-id.txt";

  if (!keypairEnv) throw new Error("WALLET_KEYPAIR env var is required (base58 secret key)");

  const wallet = Keypair.fromSecretKey(bs58.decode(keypairEnv));
  console.log(`[WorkerBot] Wallet: ${wallet.publicKey.toBase58()}`);

  const client = new Escro({ cluster: "devnet", rpcUrl, apiUrl, wallet });

  await runWorkerBot(client, { escrowIdFile });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only run when executed directly (not when imported by tests or other modules).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("[WorkerBot] Fatal error:", err);
    process.exit(1);
  });
}
