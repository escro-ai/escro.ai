/**
 * BuyerBot — reference implementation of the escrow buyer flow.
 *
 * This bot:
 *   1. Creates an escrow with a pre-assigned worker (off-platform agreement).
 *   2. Logs the escrow PDA and writes it to a file so the worker can find it.
 *   3. Polls getEscrow() every 10 s for state transitions, logging each change.
 *   4. When the worker has submitted a deliverable, asks the buyer's own accept hook once and calls
 *      releasePayment() only when it answers true. With no hook, or any other answer, it holds and
 *      returns: the escrow stays SUBMITTED until the buyer acts or the oracle's 24h timeout_release.
 *   5. Exits cleanly on COMPLETED or REFUNDED.
 *
 * Usage: see README.md
 */

import * as fs from "fs";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Escro, EscrowTimeoutError } from "../../src/index.js";
import { EscrowState } from "@escro/shared";
import type { ReviewDeliverable, TaskSpec } from "@escro/shared";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BuyerBotOptions {
  /** Worker's base-58 public key — the party assigned to execute the task. */
  workerPubkey: string;
  /** Path to write the escrow PDA so the worker can read it off-platform. */
  escrowIdFile: string;
  /**
   * How long (ms) to wait for the worker before giving up.
   * @default 3_600_000 (1 hour)
   */
  pollTimeoutMs?: number;
  /**
   * How long (ms) to wait between getEscrow polls.
   * Override in tests to skip real delays.
   * @default 10_000
   */
  pollIntervalMs?: number;
  /**
   * The buyer's own acceptance decision, called once with the submitted deliverable before any release.
   * `true` releases payment; anything else holds. Omitted: hold.
   */
  accept?: (deliverable: ReviewDeliverable) => boolean | Promise<boolean>;
}

// ── Task spec ────────────────────────────────────────────────────────────────

/**
 * TODO: Customise this task spec for your use case.
 *
 * - Change `taskType` to match the kind of work you need done.
 * - Update `description` with precise instructions for the worker/oracle.
 * - Add or remove `acceptanceCriteria` entries as needed.
 * - Adjust `deliverableFormat` to match your expected output shape.
 */
const SAMPLE_TASK_SPEC: TaskSpec = {
  version: "1.0.0",
  taskType: "data_analysis",
  description:
    "Scrape the top-10 trending tokens for 'Solana' on CoinGecko and return them as a JSON array with fields: id, name, symbol, price_usd.",
  acceptanceCriteria: [
    {
      id: "ac-format",
      description: "Response is valid JSON containing an array of at least 10 objects.",
      required: true,
    },
    {
      id: "ac-fields",
      description: "Each object has non-empty id, name, symbol, and price_usd fields.",
      required: true,
    },
    {
      id: "ac-freshness",
      description: "Data was fetched within the last 24 hours.",
    },
  ],
  deliverableFormat: {
    type: "json",
    schema: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "symbol", "price_usd"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          symbol: { type: "string" },
          price_usd: { type: "number" },
        },
      },
    },
  },
  metadata: {
    agent_hint: "Use the CoinGecko public API: GET /api/v3/search/trending",
  },
};

// ── Final state helpers ───────────────────────────────────────────────────────

// DISPUTED is not final: an arbitrator resolves it off-chain and the admin key settles it
// on-chain to COMPLETED or REFUNDED, so the bot polls on through it.
const FINAL_STATES = new Set([EscrowState.COMPLETED, EscrowState.REFUNDED, EscrowState.CANCELLED]);

const POLL_INTERVAL_MS = 10_000;

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Run the full buyer-bot flow.
 * Exported so it can be called from tests and the E2E script.
 */
export async function runBuyerBot(client: Escro, opts: BuyerBotOptions): Promise<void> {
  const {
    workerPubkey,
    escrowIdFile,
    pollTimeoutMs = 3_600_000,
    pollIntervalMs = POLL_INTERVAL_MS,
    accept,
  } = opts;

  // ── Step 1: Create escrow ─────────────────────────────────────────────────

  console.log("[BuyerBot] Creating escrow...");

  /**
   * TODO: Adjust amountUsdc and deadlineUnix for your task.
   *   - amountUsdc is in μUSDC (1 USDC = 1_000_000).
   *   - deadlineUnix is the Unix timestamp (seconds) at which the task expires.
   *     Must be at least 60s in the future and within 30 days.
   */
  const deadlineUnix = Math.floor(Date.now() / 1000) + 3_600; // 1 hour from now
  const { escrowId, escrowPda, signature } = await client.createEscrow({
    taskSpec: SAMPLE_TASK_SPEC,
    amountUsdc: 5_000_000, // TODO: set your desired payment (5 USDC)
    deadlineUnix,
    assignedWorker: workerPubkey,
  });

  console.log(`[BuyerBot] Escrow created`);
  console.log(`[BuyerBot]   PDA:       ${escrowPda}`);
  console.log(`[BuyerBot]   ID:        ${escrowId}`);
  console.log(`[BuyerBot]   Tx:        ${signature}`);
  console.log(`[BuyerBot] <<< SHARE THIS ESCROW ID OFF-PLATFORM: ${escrowPda} >>>`);

  // ── Step 2: Write escrow PDA to file (off-platform communication) ─────────

  fs.writeFileSync(escrowIdFile, escrowPda, "utf8");
  console.log(`[BuyerBot] Escrow PDA written to ${escrowIdFile}`);

  // ── Step 3: Poll for state transitions ───────────────────────────────────

  console.log("[BuyerBot] Polling for worker activity (every 10 s)...");

  const deadline = Date.now() + pollTimeoutMs;
  let lastState: EscrowState | null = null;
  let released = false;

  while (true) {
    if (Date.now() >= deadline) {
      console.error(
        `[BuyerBot] Poll timeout after ${pollTimeoutMs / 1000}s — no final state reached.`,
      );
      process.exit(1);
    }

    let escrow;
    try {
      escrow = await client.getEscrow(escrowPda);
    } catch (err) {
      if (err instanceof EscrowTimeoutError) {
        // Can be thrown if getEscrow is called with poll:true and times out.
        console.error("[BuyerBot] Escrow polling timed out:", err.message);
        process.exit(1);
      }
      throw err;
    }

    if (escrow.state !== lastState) {
      console.log(`[BuyerBot] State transition: ${lastState ?? "(initial)"} → ${escrow.state}`);
      lastState = escrow.state;
    }

    // ── Step 4: The buyer's accept hook decides release on SUBMITTED ─────

    // Once released, a read model that still shows SUBMITTED is lag: poll on to COMPLETED.
    if (escrow.state === EscrowState.SUBMITTED && !released && escrow.deliverableHash !== null) {
      const deliverable: ReviewDeliverable = {
        contentHash: escrow.deliverableHash,
        proofUri: escrow.proofUri,
      };
      const accepted = accept === undefined ? false : await accept(deliverable);
      if (accepted !== true) {
        console.log(
          `[BuyerBot] Holding escrow ${escrowPda}: no release and no dispute sent. The oracle's timeout_release pays the worker 24h after submission unless the buyer raises a dispute first.`,
        );
        return;
      }
      console.log("[BuyerBot] Deliverable accepted. Releasing payment...");
      const releaseSig = await client.releasePayment(escrowPda);
      released = true;
      console.log(`[BuyerBot] Payment released. Tx: ${releaseSig}`);
      // Re-poll immediately — don't sleep after triggering a state change.
      continue;
    }

    if (FINAL_STATES.has(escrow.state)) {
      console.log(`[BuyerBot] Escrow reached its final state: ${escrow.state}. Exiting.`);
      break;
    }

    await sleep(pollIntervalMs);
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
  const apiUrl = process.env.API_URL ?? "http://localhost:3000";
  const keypairEnv = process.env.WALLET_KEYPAIR;
  const workerPubkey = process.env.WORKER_PUBKEY;
  const escrowIdFile = process.env.ESCROW_ID_FILE ?? "/tmp/escro-e2e-escrow-id.txt";

  if (!keypairEnv) throw new Error("WALLET_KEYPAIR env var is required (base58 secret key)");
  if (!workerPubkey) throw new Error("WORKER_PUBKEY env var is required (base58 public key)");

  const wallet = Keypair.fromSecretKey(bs58.decode(keypairEnv));
  console.log(`[BuyerBot] Wallet: ${wallet.publicKey.toBase58()}`);

  const client = new Escro({ cluster: "devnet", rpcUrl, apiUrl, wallet });

  await runBuyerBot(client, { workerPubkey, escrowIdFile });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only run when executed directly (not when imported by tests or other modules).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("[BuyerBot] Fatal error:", err);
    process.exit(1);
  });
}
