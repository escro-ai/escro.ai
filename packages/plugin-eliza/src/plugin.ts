import type { Acceptance } from "@escro/sdk";
import type { Action, Plugin } from "./eliza.js";
import { commissionTaskAction, makeCommissionTaskAction } from "./actions/commission-task.js";
import { makePay402Action, pay402Action } from "./actions/pay-402.js";
import { makeReviewDeliveryAction, reviewDeliveryAction } from "./actions/review-delivery.js";
import type { ReviewHook } from "./actions/review-delivery.js";
import type { ChatInputAuthorizer } from "./actions/shared.js";

const NAME = "escro";
const DESCRIPTION =
  "Escrow for AI agents: commission asynchronous bot-to-bot work or fund a worker's 402 with " +
  "USDC held in a conditional-release escrow on Solana, and settle the delivery with the " +
  "operator's own predicate.";

function plugin(actions: Action[]): Plugin {
  return { name: NAME, description: DESCRIPTION, actions };
}

/** What only the operator may decide; a chat message can set none of these. */
export interface EscroPluginOptions {
  review?: ReviewHook;
  admitAcceptance?: (acceptance: Acceptance) => boolean;
  authorizeChatInput?: ChatInputAuthorizer;
}

/**
 * The plugin with the operator's decisions wired in. Without a `review` hook `REVIEW_DELIVERY`
 * refuses, so settlement exists only for an operator who registers this form.
 */
export function createEscroPlugin(options: EscroPluginOptions = {}): Plugin {
  const { review, admitAcceptance, authorizeChatInput } = options;
  const chatDeps = authorizeChatInput !== undefined ? { authorizeChatInput } : {};
  return plugin([
    makeCommissionTaskAction(chatDeps),
    makePay402Action({
      ...chatDeps,
      ...(admitAcceptance !== undefined && { admitAcceptance }),
    }),
    makeReviewDeliveryAction(review !== undefined ? { review } : {}),
  ]);
}

/**
 * The plugin a character loads by name: it commissions and funds 402s once an operator admits chat
 * input, and has no review hook, so it can never release. The agent's operator remains the judge.
 */
export const escroPlugin: Plugin = plugin([
  commissionTaskAction,
  pay402Action,
  reviewDeliveryAction,
]);

export default escroPlugin;
