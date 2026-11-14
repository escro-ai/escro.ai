import type { Action, ActionResult, IAgentRuntime } from "../eliza.js";
import type { EscroClient } from "../client.js";
import { createEscroClientFromRuntime } from "../client.js";
import { buildCreateEscrowParams, parseCommissionInput } from "../schema.js";
import type { CommissionInput } from "../schema.js";
import {
  chatInputGate,
  createOnce,
  failureHandle,
  failureReason,
  readActionInput,
  walletConfigured,
} from "./shared.js";
import type { ChatInputAuthorizer } from "./shared.js";

/** Injectable dependencies for the commission action (mockable in tests). */
export interface CommissionTaskDeps {
  /** Build the Escro client for a given runtime. Defaults to the settings-based factory. */
  createClient: (runtime: IAgentRuntime) => EscroClient;
  /** Decides whether a commission read from chat text may spend; see `chatInputGate`. */
  authorizeChatInput?: ChatInputAuthorizer;
}

/** Action name exposed to the elizaOS runtime. */
export const COMMISSION_TASK = "COMMISSION_TASK";

/** Format micro-USDC as a plain decimal string, e.g. 5_000_000 -> "5.00". */
function formatUsdc(microUsdc: number): string {
  return (microUsdc / 1_000_000).toFixed(2);
}

/**
 * Build the `commission_task` action, wrapping the Escro SDK's `createEscrow`.
 * The client factory is injectable so tests never touch Solana.
 *
 * This action is a thin wrapper: it locks funds against an assigned worker and
 * reports the escrow. It makes NO judgment about deliverable quality - the agent
 * (Buyer) reviews and releases, and Escro defaults to refund if nothing arrives.
 */
export function makeCommissionTaskAction(deps?: Partial<CommissionTaskDeps>): Action {
  const createClient = deps?.createClient ?? createEscroClientFromRuntime;
  const gateDeps =
    deps?.authorizeChatInput !== undefined ? { authorizeChatInput: deps.authorizeChatInput } : {};
  const once = createOnce();

  const commission = async (
    runtime: IAgentRuntime,
    input: CommissionInput,
  ): Promise<ActionResult> => {
    const params = buildCreateEscrowParams(input);
    const client = createClient(runtime);
    const confirmed = input.wait !== false;
    const result = confirmed
      ? await client.createEscrow(params)
      : await client.createEscrow(params, { wait: false });

    const amount = `$${formatUsdc(input.amountUsdc)} USDC`;
    const text = confirmed
      ? `Commissioned worker ${input.worker}: locked ${amount} in escrow ${result.escrowPda} ` +
        `(tx ${result.signature}). The worker is paid when you release the escrow after approving ` +
        "their delivery, or automatically 24 hours after a submission you leave unreviewed, so " +
        "review it, or dispute it, within that window."
      : `Commission sent for worker ${input.worker}: ${amount} for escrow ${result.escrowPda} ` +
        `(tx ${result.signature}), not yet confirmed. Read the escrow until it is FUNDED before ` +
        "counting on it.";

    runtime.logger?.info(
      `[escro] commission_task sent escrow ${result.escrowPda} for worker ${input.worker}`,
    );
    return {
      success: true,
      text,
      data: {
        escrowPda: result.escrowPda,
        escrowId: result.escrowId,
        signature: result.signature,
        assignedWorker: input.worker,
        amountUsdc: input.amountUsdc,
        confirmed,
      },
    };
  };

  const failed = (runtime: IAgentRuntime, err: unknown): ActionResult => {
    const reason = failureReason(err, "commission");
    const handle = failureHandle(err);
    const text =
      handle === null
        ? `Could not commission the task: ${reason}`
        : `Could not commission the task: ${reason} Escrow ${handle.escrowPda} ` +
          `(tx ${handle.signature}) may already be funded: do not retry this commission, read ` +
          "the escrow first.";
    runtime.logger?.error(`[escro] commission_task failed: ${reason}`);
    return {
      success: false,
      text,
      ...(handle !== null && { data: { ...handle } }),
      error: err instanceof Error ? err : new Error(reason),
    };
  };

  return {
    name: COMMISSION_TASK,
    similes: ["HIRE_WORKER", "COMMISSION_WORK", "CREATE_ESCROW", "PAY_FOR_TASK"],
    description:
      "Commission asynchronous work from a specific worker bot by locking USDC in an " +
      "Escro conditional-release escrow. Funds release when the buyer approves the delivered " +
      "work, or to the worker 24 hours after a submission the buyer leaves unreviewed, and " +
      "default to refund if the work never arrives; the action never judges quality.",
    validate: (runtime: IAgentRuntime): Promise<boolean> =>
      Promise.resolve(walletConfigured(runtime)),
    handler: async (runtime, message, _state, options, callback) => {
      let input: CommissionInput;
      try {
        input = parseCommissionInput(
          await readActionInput(
            message,
            options,
            "commission",
            chatInputGate(gateDeps, runtime, message),
          ),
        );
      } catch (err) {
        const result = failed(runtime, err);
        await callback?.({ text: result.text ?? "", actions: [COMMISSION_TASK] });
        return result;
      }
      return once(message.id, input, async () => {
        let result: ActionResult;
        try {
          result = await commission(runtime, input);
        } catch (err) {
          result = failed(runtime, err);
        }
        await callback?.({ text: result.text ?? "", actions: [COMMISSION_TASK] });
        return result;
      });
    },
    examples: [
      [
        {
          name: "{{user}}",
          content: {
            text: 'Hire this worker to summarize the report.\n\n```json\n{"worker":"So11111111111111111111111111111111111111112","amountUsdc":5000000,"deadlineSeconds":3600,"task":{"description":"Summarize the attached report into five bullet points.","taskType":"summarization","acceptanceCriteria":[{"id":"ac-1","description":"Exactly five bullets","required":true}]}}\n```',
          },
        },
        {
          name: "{{agent}}",
          content: {
            text: "Locking 5.00 USDC in an Escro escrow for that worker. I will review the summary within 24 hours of its submission and release it or dispute it.",
            actions: [COMMISSION_TASK],
          },
        },
      ],
    ],
  };
}

/** The default `commission_task` action using the settings-based client factory. */
export const commissionTaskAction: Action = makeCommissionTaskAction();
