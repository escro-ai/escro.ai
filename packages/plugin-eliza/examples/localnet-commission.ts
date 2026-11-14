/**
 * End-to-end example: drive the Escro `commission_task` action against a
 * Solana cluster, exactly as the elizaOS runtime would call it.
 *
 * It needs an Escro API and a funded buyer wallet; it starts neither. After `pnpm install` and
 * `pnpm build`, run it against the hosted devnet API with a wallet holding devnet SOL and devnet
 * USDC:
 *
 *   ESCRO_WALLET_SECRET=<base58 buyer secret> \
 *   WORKER_PUBKEY=<assigned worker base58 pubkey> \
 *   ESCRO_CLUSTER=devnet \
 *   npx tsx packages/plugin-eliza/examples/localnet-commission.ts
 *
 * For another deployment, also set ESCRO_API_URL and ESCRO_RPC_URL to its API and validator.
 *
 * The wallet secret is read from the environment and never logged.
 */
import { fileURLToPath } from "url";
import { MIN_ESCROW_AMOUNT } from "@escro/shared";
import {
  commissionTaskAction,
  type Content,
  type IAgentRuntime,
  type Memory,
} from "../src/index.js";

/** Minimal runtime backed by environment variables, matching what elizaOS provides. */
function envRuntime(): IAgentRuntime {
  return {
    getSetting: (key: string): string | boolean | number | null => process.env[key] ?? null,
    logger: {
      info: (...args: unknown[]) => {
        console.log("[info]", ...args);
      },
      warn: (...args: unknown[]) => {
        console.warn("[warn]", ...args);
      },
      error: (...args: unknown[]) => {
        console.error("[error]", ...args);
      },
      debug: (...args: unknown[]) => {
        console.debug("[debug]", ...args);
      },
    },
  };
}

async function main(): Promise<void> {
  const worker = process.env.WORKER_PUBKEY;
  if (worker === undefined || worker.length === 0) {
    throw new Error("WORKER_PUBKEY env var is required (assigned worker base58 pubkey).");
  }

  const runtime = envRuntime();
  const message: Memory = {
    content: {
      text: "Commission the assigned worker to summarize a document.",
      commission: {
        worker,
        amountUsdc: MIN_ESCROW_AMOUNT,
        deadlineSeconds: 3600,
        task: {
          description: "Summarize the attached document into exactly five bullet points.",
          taskType: "summarization",
          acceptanceCriteria: [
            { id: "ac-format", description: "Exactly five bullet points", required: true },
          ],
        },
      },
    },
  };

  const callback = (content: Content): Promise<Memory[]> => {
    console.log(`[agent] ${content.text ?? ""}`);
    return Promise.resolve([]);
  };

  const result = await commissionTaskAction.handler(
    runtime,
    message,
    undefined,
    undefined,
    callback,
  );

  if (!result.success) {
    throw new Error(`commission_task failed: ${String(result.error ?? result.text)}`);
  }
  console.log("Escrow PDA:", result.data?.escrowPda);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("[localnet-commission] fatal:", err);
    process.exit(1);
  });
}
