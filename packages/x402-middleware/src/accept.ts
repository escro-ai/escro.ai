// The wire members the menu builds: the `on-delivery` entry with its `extensions.escro`, and the claim's settlement
// response (docs/specs/scheme_on_delivery_svm.md, docs/specs/escro-extension.md).
import {
  ONCHAIN_REFUND_GRACE_SECONDS,
  buildEscrowAccept,
  computeTaskSpecHash,
  type Acceptance,
  type EscroExtensionInfo,
  type EscroNextAction,
  type EscroReceipt,
  type OnDeliveryAccept,
  type SettlementResponse,
  type TaskSpec,
} from "@escro/sdk";

import type { MenuCluster, RouteExtension } from "./index.js";

/** The `$id` of docs/specs/escro-extension.schema.json; the extension carries its schema by this reference. */
const EXTENSION_SCHEMA_URI = "https://escro.ai/schemas/escro-extension/0.4.json";

export interface EscrowAcceptOptions {
  cluster: MenuCluster;
  payTo: string;
  priceMicroUsdc: bigint;
  taskSpec: TaskSpec;
  specUri: string;
  feeBps: number;
  deadline: number;
  maxTimeoutSeconds: number;
  extension?: RouteExtension;
}

export interface BuiltEscrowAccept {
  accept: OnDeliveryAccept;
  specHash: string;
  extension?: { info: EscroExtensionInfo; schema: { $ref: string } };
}

const settlementTerms = (entry: OnDeliveryAccept): EscroExtensionInfo["settlement"] => ({
  reviewWindowSeconds: entry.extra.reviewWindowSeconds,
  settlementMode: entry.extra.settlementMode,
  feePayer: entry.extra.feePayer,
});

function advertised(terms: {
  acceptance?: Acceptance | undefined;
  receipt?: EscroReceipt | undefined;
}): Pick<EscroExtensionInfo, "acceptance" | "receipt"> {
  return {
    ...(terms.acceptance === undefined ? {} : { acceptance: terms.acceptance }),
    ...(terms.receipt === undefined ? {} : { receipt: terms.receipt }),
  };
}

/** The `on-delivery` entry for a job, its spec hash, and (unless `extension` is false) its `extensions.escro`. */
export function escrowAccept(options: EscrowAcceptOptions): BuiltEscrowAccept {
  const specHash = computeTaskSpecHash(options.taskSpec);
  const accept = buildEscrowAccept({
    cluster: options.cluster,
    amountMicroUsdc: options.priceMicroUsdc,
    payTo: options.payTo,
    specHash,
    specUri: options.specUri,
    deadline: options.deadline,
    feeBps: options.feeBps,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
  });
  const { extension } = options;
  if (extension === false) return { accept, specHash };
  const nextActions: EscroNextAction[] = [
    {
      action: "fund",
      actor: "buyer",
      channel: "onchain",
      network: accept.network,
      instruction: "create_escrow",
    },
  ];
  if (extension?.mcpServer !== undefined) {
    nextActions.push({
      action: "fund",
      actor: "buyer",
      channel: "mcp",
      server: extension.mcpServer,
      tool: "create_escrow",
    });
  }
  const settlement = settlementTerms(accept);
  return {
    accept,
    specHash,
    extension: {
      info: {
        ...advertised(extension ?? {}),
        ...(settlement === undefined ? {} : { settlement }),
        nextActions,
      },
      schema: { $ref: EXTENSION_SCHEMA_URI },
    },
  };
}

export interface ClaimSettlementInput {
  entry: OnDeliveryAccept;
  escrow: string;
  buyer: string;
  /** The escrow's on-chain deadline, Unix seconds. */
  escrowDeadline: number;
  claimSignature: string;
  pollUrl: string;
  extension?: false | { acceptance?: Acceptance; receipt?: EscroReceipt };
}

/** The claim's `PAYMENT-RESPONSE`: the steps legal while the work runs, mirroring the 402's terms. */
export function claimSettlement(input: ClaimSettlementInput): SettlementResponse {
  const { entry, escrow, buyer, escrowDeadline, claimSignature, pollUrl, extension } = input;
  const response: SettlementResponse = {
    success: true,
    transaction: claimSignature,
    network: entry.network,
    payer: buyer,
  };
  if (extension === false) return response;
  const { network } = entry;
  const onchain = (
    action: string,
    actor: string,
    instruction: string,
    notBefore?: number,
  ): EscroNextAction => ({
    action,
    actor,
    channel: "onchain",
    network,
    instruction,
    address: escrow,
    ...(notBefore === undefined ? {} : { notBefore }),
  });
  const nextActions: EscroNextAction[] = [
    // The schema admits only https: for a server-channel step.
    ...(pollUrl.startsWith("https:")
      ? [
          {
            action: "poll",
            actor: "buyer",
            channel: "server" as const,
            method: "GET" as const,
            url: pollUrl,
          },
        ]
      : []),
    onchain("submit", "worker", "submit_deliverable"),
    onchain("dispute", "buyer", "raise_dispute"),
    // refund_buyer is accepted only strictly after deadline + grace.
    onchain("refund", "anyone", "refund_buyer", escrowDeadline + ONCHAIN_REFUND_GRACE_SECONDS + 1),
  ];
  const settlement = settlementTerms(entry);
  const info: EscroExtensionInfo = {
    ...advertised(extension ?? {}),
    ...(settlement === undefined ? {} : { settlement }),
    nextActions,
  };
  return { ...response, extensions: { escro: { info } } };
}
