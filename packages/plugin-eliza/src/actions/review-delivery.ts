import { EscrowState, predicateJob, predicateMemo, runPredicate } from "@escro/sdk";
import type { Delivery, EscrowAccount, PredicateCheck, PredicateContext } from "@escro/sdk";
import type { SolanaCluster } from "@escro/shared";
import { z } from "zod";
import type { EscroClient } from "../client.js";
import { createEscroClientFromRuntime, resolveClientConfig } from "../client.js";
import type { Action, ActionResult, IAgentRuntime } from "../eliza.js";
import { ActionInputError, EscroPluginError } from "../errors.js";
import {
  createOnce,
  failureHandle,
  failureReason,
  type FailureHandle,
  readActionInput,
  refuseSiblings,
  walletConfigured,
} from "./shared.js";

/** Action name exposed to the elizaOS runtime. */
export const REVIEW_DELIVERY = "REVIEW_DELIVERY";

/**
 * The operator's decision input for one delivery: the expectation and the bytes are its own. The
 * record's job is the action's to bind (the reviewed escrow on the runtime's cluster), never the hook's.
 */
export interface PredicateReview {
  check: Omit<PredicateCheck, "job">;
  delivery: Delivery;
  context?: PredicateContext;
  onFail?: "hold" | "dispute";
}

/** Answers null to make no decision: nothing is released and the escrow stays held. */
export type ReviewHook = (escrow: EscrowAccount) => Promise<PredicateReview | null>;

export interface ReviewDeliveryDeps {
  createClient: (runtime: IAgentRuntime) => EscroClient;
  review?: ReviewHook;
}

const HOLD_WARNING =
  "Nothing was released. A held delivery auto-releases to the worker at the 24h timeout: " +
  "review it, or dispute it, before then.";

const reviewInputSchema = z.object({ escrow: z.string().min(32).max(44) }).strict();

type ReviewInput = z.infer<typeof reviewInputSchema>;

function parseReviewInput(raw: unknown): ReviewInput {
  const result = reviewInputSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ActionInputError(`Invalid review parameters - ${detail}`);
  }
  return result.data;
}

/**
 * A send leg's error carries only `signature`, the escrow being the caller's. The transaction may
 * have landed unless the chain reported it failed (`TX_FAILED`) or the RPC refused it at preflight
 * for a reason other than its having been processed already.
 */
function sentHandle(err: unknown, escrow: string): FailureHandle | null {
  if (typeof err !== "object" || err === null) return null;
  const { signature, code, transactionError } = err as Record<string, unknown>;
  if (typeof signature !== "string" || code === "TX_FAILED") return null;
  const refusal = (transactionError as { message?: unknown } | null | undefined)?.message;
  if (typeof refusal === "string" && !/already been processed/i.test(refusal)) return null;
  return { escrowPda: escrow, signature };
}

/**
 * Build the `REVIEW_DELIVERY` action. The buyer is the judge: the check and the delivered bytes come
 * only from the operator's hook, and a chat message can name nothing but the escrow, which is why a
 * fenced block needs no consent here.
 */
export function makeReviewDeliveryAction(deps?: Partial<ReviewDeliveryDeps>): Action {
  const createClient = deps?.createClient ?? createEscroClientFromRuntime;
  const review = deps?.review;
  const once = createOnce();

  // `heldEscrow` is given once the escrow has been read as SUBMITTED: a failure from there leaves it
  // to the oracle's auto-release unless the error says a transaction may have landed.
  const failed = (runtime: IAgentRuntime, err: unknown, heldEscrow?: string): ActionResult => {
    const reason = failureReason(err, "review");
    const handle =
      failureHandle(err) ?? (heldEscrow === undefined ? null : sentHandle(err, heldEscrow));
    const text =
      handle === null
        ? `Could not review the delivery: ${reason}` +
          (heldEscrow === undefined ? "" : ` ${HOLD_WARNING}`)
        : `Could not review the delivery: ${reason} Escrow ${handle.escrowPda} (tx ` +
          `${handle.signature}) may already have moved: do not retry this review, read the ` +
          "escrow first.";
    runtime.logger?.error(`[escro] review_delivery failed: ${reason}`);
    // A new Error, not `err`: the SDK's `cause` chain stays out of what the runtime may log or store.
    return {
      success: false,
      text,
      ...(handle !== null && { data: { ...handle } }),
      error: new Error(reason),
    };
  };

  const decide = async (
    runtime: IAgentRuntime,
    hook: ReviewHook,
    { escrow }: ReviewInput,
  ): Promise<ActionResult> => {
    const client = createClient(runtime);
    const account = await client.getEscrow(escrow);
    if (account.state !== EscrowState.SUBMITTED) {
      throw new EscroPluginError(
        `escrow ${escrow} is ${account.state}, not SUBMITTED, so there is no delivery to review`,
      );
    }
    try {
      return await judge(client, hook, resolveClientConfig(runtime).cluster, escrow, account);
    } catch (err) {
      return failed(runtime, err, escrow);
    }
  };

  const judge = async (
    client: EscroClient,
    hook: ReviewHook,
    cluster: SolanaCluster,
    escrow: string,
    account: EscrowAccount,
  ): Promise<ActionResult> => {
    const decision = await hook(account);
    if (decision === null) {
      return {
        success: true,
        text: `The review hook made no decision on escrow ${escrow}. ${HOLD_WARNING}`,
        data: { decision: "none", held: true },
      };
    }

    // The job is spread last, so a job a JavaScript hook put on its check never reaches the record.
    const result = await runPredicate(
      { ...decision.check, job: predicateJob(cluster, escrow) },
      decision.delivery,
      decision.context ?? {},
    );
    const name = decision.check.acceptance.name;

    if (result.record.decision === "pass") {
      const outcome = await client.releaseWithPredicate(escrow, result);
      const recorded = outcome.confirm.landed;
      return {
        success: true,
        text:
          `Released escrow ${escrow} on predicate ${name} (tx ${outcome.signature}).` +
          (recorded ? "" : " The Escro API has not recorded it yet."),
        data: {
          decision: "pass",
          memo: predicateMemo(result.record),
          signature: outcome.signature,
          recorded,
          reason: result.reason,
        },
      };
    }

    if (decision.onFail === "dispute") {
      const signature = await client.raiseDispute(escrow, {
        reason: `predicate ${name} failed`,
      });
      return {
        success: true,
        text: `Predicate ${name} failed on escrow ${escrow}: dispute raised (tx ${signature}).`,
        data: { decision: "fail", signature, reason: result.reason, disputed: true },
      };
    }
    return {
      success: true,
      text: `Predicate ${name} failed on escrow ${escrow}. ${HOLD_WARNING}`,
      data: { decision: "fail", reason: result.reason, held: true },
    };
  };

  return {
    name: REVIEW_DELIVERY,
    similes: ["SETTLE_DELIVERY", "CHECK_DELIVERY", "RELEASE_IF_PASSED"],
    description:
      "Settle a submitted Escro delivery with the operator's own predicate: release on a pass, " +
      "hold or dispute on a fail. The action never judges quality itself.",
    validate: (runtime: IAgentRuntime): Promise<boolean> =>
      Promise.resolve(review !== undefined && walletConfigured(runtime)),
    handler: async (runtime, message, _state, options, callback) => {
      let input: ReviewInput;
      try {
        refuseSiblings(message, options, ["params", "sha256", "acceptance", "delivery"]);
        if (review === undefined) {
          throw new ActionInputError(
            "no review hook is registered: an operator registers one with createEscroPlugin({ review })",
          );
        }
        input = parseReviewInput(
          await readActionInput(message, options, "reviewDelivery", () => Promise.resolve(true)),
        );
      } catch (err) {
        const result = failed(runtime, err);
        await callback?.({ text: result.text ?? "", actions: [REVIEW_DELIVERY] });
        return result;
      }
      return once(message.id, input, async () => {
        let result: ActionResult;
        try {
          result = await decide(runtime, review, input);
        } catch (err) {
          result = failed(runtime, err);
        }
        await callback?.({ text: result.text ?? "", actions: [REVIEW_DELIVERY] });
        return result;
      });
    },
    examples: [],
  };
}

/** The default `REVIEW_DELIVERY` action: no hook, so it refuses every delivery. */
export const reviewDeliveryAction: Action = makeReviewDeliveryAction();
