/**
 * Full end-to-end integration test — runs BuyerBot and WorkerBot against Devnet.
 *
 * Both bots run concurrently and coordinate via a temp file (simulating
 * off-platform communication of the escrow PDA).
 *
 * Asserts that the full happy path completes in under 60 seconds.
 *
 * Prerequisites:
 *   - A running escro API (set API_URL)
 *   - Two funded devnet wallets (BUYER_KEYPAIR and WORKER_KEYPAIR)
 *   - Network access to Devnet RPC
 *
 * Run:
 *   BUYER_KEYPAIR=... WORKER_KEYPAIR=... DEVNET_RPC=... API_URL=... \
 *     npx tsx examples/full-e2e-test.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Escro, EscrowTimeoutError } from "../src/index.js";
import { EscrowState } from "@escro/shared";
import { runBuyerBot } from "./buyer-bot/index.js";
import { runWorkerBot } from "./worker-bot/index.js";

// ── Config ───────────────────────────────────────────────────────────────────

const HAPPY_PATH_TIMEOUT_MS = 60_000;
const ESCROW_ID_FILE = path.join(os.tmpdir(), `escro-e2e-${Date.now()}.txt`);

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} env var is required`);
  return val;
}

// ── Assertions ───────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ── E2E orchestration ────────────────────────────────────────────────────────

async function runE2E(): Promise<void> {
  const rpcUrl = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
  const apiUrl = process.env.API_URL ?? "http://localhost:3000";

  const buyerWallet = Keypair.fromSecretKey(bs58.decode(requireEnv("BUYER_KEYPAIR")));
  const workerWallet = Keypair.fromSecretKey(bs58.decode(requireEnv("WORKER_KEYPAIR")));

  console.log("[E2E] Buyer  wallet:", buyerWallet.publicKey.toBase58());
  console.log("[E2E] Worker wallet:", workerWallet.publicKey.toBase58());
  console.log("[E2E] Escrow ID file:", ESCROW_ID_FILE);

  const buyerClient = new Escro({ cluster: "devnet", rpcUrl, apiUrl, wallet: buyerWallet });
  const workerClient = new Escro({ cluster: "devnet", rpcUrl, apiUrl, wallet: workerWallet });

  const startMs = Date.now();

  // Run both bots concurrently.
  // - BuyerBot: creates escrow, writes PDA to file, polls for SUBMITTED, releases payment (its accept hook answers yes).
  // - WorkerBot: reads PDA from file, polls for FUNDED task, claims, executes, submits.
  // They coordinate only via ESCROW_ID_FILE (off-platform simulation).
  await Promise.all([
    runBuyerBot(buyerClient, {
      workerPubkey: workerWallet.publicKey.toBase58(),
      escrowIdFile: ESCROW_ID_FILE,
      pollTimeoutMs: HAPPY_PATH_TIMEOUT_MS,
      accept: () => true,
    }),
    runWorkerBot(workerClient, {
      escrowIdFile: ESCROW_ID_FILE,
      taskPollTimeoutMs: HAPPY_PATH_TIMEOUT_MS,
    }),
  ]);

  const elapsedMs = Date.now() - startMs;

  // ── Assertions ─────────────────────────────────────────────────────────────

  // Verify the escrow reached COMPLETED state.
  const escrowPda = fs.readFileSync(ESCROW_ID_FILE, "utf8").trim();
  let finalEscrow;
  try {
    finalEscrow = await buyerClient.getEscrow(escrowPda);
  } catch (err) {
    if (err instanceof EscrowTimeoutError) {
      throw new Error("Could not fetch final escrow state: polling timed out");
    }
    throw err;
  }

  assert(
    finalEscrow.state === EscrowState.COMPLETED,
    `Expected escrow state COMPLETED, got ${finalEscrow.state}`,
  );

  assert(
    elapsedMs < HAPPY_PATH_TIMEOUT_MS,
    `Happy path took ${elapsedMs}ms, expected < ${HAPPY_PATH_TIMEOUT_MS}ms`,
  );

  console.log(`\n[E2E] PASS — happy path completed in ${elapsedMs}ms`);
  console.log(`[E2E] Final escrow state: ${finalEscrow.state}`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup(): void {
  if (fs.existsSync(ESCROW_ID_FILE)) {
    fs.unlinkSync(ESCROW_ID_FILE);
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

runE2E()
  .then(cleanup)
  .catch((err: unknown) => {
    console.error("\n[E2E] FAIL —", err instanceof Error ? err.message : err);
    cleanup();
    process.exit(1);
  });
