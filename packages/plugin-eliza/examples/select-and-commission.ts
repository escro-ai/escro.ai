/**
 * End-to-end example: pick a worker from the EscroBots directory using EscroRep
 * raw components, then commission it - exactly as an elizaOS agent would.
 *
 * EscroRep is the DEFAULT supplier-selection INPUT, but
 * the weighting is entirely the caller's. `findWorkersWithReputation` joins each
 * directory candidate to its verified on-chain history; the agent supplies its own
 * `weight` function (below) and `selectWorker` returns the top choice, ties broken
 * by registry order. Escro ships no default ranking - swap the weight for your own.
 *
 * It needs an Escro API and a funded buyer wallet; it starts neither. After `pnpm install` and
 * `pnpm build`, run it against the hosted devnet API with a wallet holding devnet SOL and devnet
 * USDC:
 *
 *   ESCRO_WALLET_SECRET=<base58 buyer secret> \
 *   ESCRO_CLUSTER=devnet \
 *   CAPABILITY=summarization \
 *   npx tsx packages/plugin-eliza/examples/select-and-commission.ts
 *
 * For another deployment, also set ESCRO_API_URL and ESCRO_RPC_URL to its API and validator.
 *
 * The wallet secret is read from the environment and never logged.
 */
import { fileURLToPath } from "url";
import { MIN_ESCROW_AMOUNT } from "@escro/shared";
import {
  commissionTaskAction,
  createEscroClientFromRuntime,
  findWorkersWithReputation,
  selectWorker,
  type Content,
  type IAgentRuntime,
  type Memory,
  type WorkerWithReputation,
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

/**
 * The CALLER's weighting - an illustration, NOT shipped by Escro. This agent
 * prefers workers with more completions and a lower dispute rate, and is willing
 * to try a worker with no history (reputation === null) as a low-priority fallback.
 * Read the raw components however your own bot judges fit.
 */
function myWeight(worker: WorkerWithReputation): number {
  const rep = worker.reputation;
  if (rep === null) return 0.1; // unproven worker: better than nothing, worse than any track record
  const { completions, disputeRate } = rep.asWorker;
  return completions * (1 - (disputeRate ?? 0));
}

async function main(): Promise<void> {
  const capability = process.env.CAPABILITY;
  const runtime = envRuntime();
  const client = createEscroClientFromRuntime(runtime);

  const candidates = await findWorkersWithReputation(
    client,
    capability !== undefined && capability.length > 0 ? { capability } : {},
  );
  if (candidates.length === 0) {
    throw new Error("No workers found in the directory for the requested capability.");
  }

  const chosen = selectWorker(candidates, myWeight);
  if (chosen === undefined) {
    throw new Error("No worker selected.");
  }
  console.log(
    `[select] chose ${chosen.descriptor.wallet} ` +
      `(completions=${(chosen.reputation?.asWorker.completions ?? 0).toString()}, ` +
      `signatureValid=${chosen.signatureValid.toString()})`,
  );

  const message: Memory = {
    content: {
      text: "Commission the selected worker to summarize a document.",
      commission: {
        worker: chosen.descriptor.wallet,
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
    console.error("[select-and-commission] fatal:", err);
    process.exit(1);
  });
}
