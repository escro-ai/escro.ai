// Hire a worker through its 402: `pay()` funds the offer's on-delivery entry for exactly the
// configured worker and price, under the SDK's spend cap, and presents the funded escrow.
//
// The SDK's cap is this bot's only cap, the one every create runs, here and on the plain create
// path. It runs once inside `pay()`'s create, before the transaction exists, and counts amount
// plus fee against this wallet's open escrows.

import { deadlineBoundedPolicy, parseUsdc } from "@escro/sdk";
import type {
  Escro,
  EscroOptions,
  PaymentResult,
  PayPolicy,
  PayRequest,
  SpendCap,
} from "@escro/sdk";
import type { Acceptance } from "@escro/sdk";
import type { BuyerLogger } from "./buyer.js";
import type { Telemetry } from "./telemetry.js";

export type BuyerPayClient = Pick<Escro, "pay">;

export interface HireTerms {
  /** The worker's paid URL, requested for its 402. */
  url: string;
  /** The only wallet paid. */
  worker: string;
  /** The exact price in micro-USDC, net of the fee: `pay()` matches it, it is not a maximum. */
  amountMicroUsdc: number;
  /** The offer's deadline may be at most this many seconds from now. */
  deadlineSeconds: number;
  /** This bot's cluster: only the 402's entries on its network are paid. */
  cluster: EscroOptions["cluster"];
  method: "GET" | "POST";
  /** Sent as the JSON body of the request, unpaid and paid alike. */
  input?: unknown;
  /**
   * The check this buyer runs on the delivery. A 402 carrying an `acceptance` is funded only when
   * it is exactly this one; unset, any 402 carrying one is refused.
   */
  acceptance?: Acceptance;
}

/** Admits exactly `own`: the same name and params hash, and no fixtures this buyer was not given. */
function ownAcceptanceOnly(own: Acceptance): (offered: Acceptance) => boolean {
  return (offered) =>
    offered.name === own.name &&
    offered.paramsHash === own.paramsHash &&
    (offered.fixtureHashes ?? []).length === 0;
}

/**
 * The SDK's deadline-bounded policy, escrow-only, over the 402's `on-delivery` entries alone (the
 * elements themselves) on this bot's cluster. An `exact` entry is never taken, so enabling the x402
 * rail in the SDK cannot move this bot's money outside the escrow rail. The deadline bound stops a
 * 402 locking the deposit past the job's own horizon. Refusals are the SDK's.
 */
export function onDeliveryPolicy(
  terms: Pick<HireTerms, "worker" | "amountMicroUsdc" | "deadlineSeconds" | "cluster">,
  now?: () => number,
): PayPolicy {
  const policy = deadlineBoundedPolicy({
    to: terms.worker,
    amountMicroUsdc: terms.amountMicroUsdc,
    cluster: terms.cluster,
    maxDeadlineSeconds: terms.deadlineSeconds,
    escrowOnly: true,
    ...(now !== undefined && { now }),
  });
  return (accepts, offer) =>
    policy(
      accepts.filter((entry) => entry.scheme === "on-delivery"),
      offer,
    );
}

/** The SDK's spend cap for a cap configured in USDC; no cap configured is no cap. */
export function hireSpendCap(spendCapUsdc: number | undefined): SpendCap | undefined {
  if (spendCapUsdc === undefined) return undefined;
  return { maxOutstandingMicroUsdc: parseUsdc(String(spendCapUsdc)) };
}

/** Tells the operator where a failed hire's deposit is, when the rejection carries a handle. */
function logFundingHandle(err: unknown, log: BuyerLogger): void {
  if (typeof err !== "object" || err === null) return;
  const { escrowPda, createSignature, signature, address, code } = err as Record<string, unknown>;

  const fundedSignature = createSignature ?? signature;
  if (typeof escrowPda === "string" && typeof fundedSignature === "string") {
    log.error(
      `[buyer] The hire failed after funding escrow ${escrowPda} (signature ${fundedSignature}). ` +
        "The cancel pass recovers the deposit after the deadline while the escrow is still FUNDED; " +
        "a claimed escrow settles, or refund_buyer returns it.",
    );
    return;
  }
  // A TX_FAILED create carries the same two fields and moved no deposit.
  if (typeof address === "string" && typeof signature === "string" && code !== "TX_FAILED") {
    log.error(
      `[buyer] The create of escrow ${address} landed or was sent (signature ${signature}) but the API has not recorded it. ` +
        "The cancel pass reaches it only once the API records it (within about a minute), or call confirm(address, signature).",
    );
  }
}

/** Hires once over the 402. A rejection is logged with any funded escrow's handle and rethrown. */
export async function hireOver402(
  client: BuyerPayClient,
  terms: HireTerms,
  opts: { logger?: BuyerLogger; telemetry?: Telemetry } = {},
): Promise<PaymentResult> {
  const log = opts.logger ?? console;
  const request: PayRequest = {
    method: terms.method,
    ...(terms.input !== undefined && {
      body: JSON.stringify(terms.input),
      headers: { "content-type": "application/json" },
    }),
  };

  opts.telemetry?.stage("worker_hired");
  let result: PaymentResult;
  try {
    result = await client.pay({
      to: terms.worker,
      amountMicroUsdc: terms.amountMicroUsdc,
      url: terms.url,
      policy: onDeliveryPolicy(terms),
      request,
      ...(terms.acceptance !== undefined && {
        admitAcceptance: ownAcceptanceOnly(terms.acceptance),
      }),
    });
  } catch (err) {
    logFundingHandle(err, log);
    throw err;
  }
  log.info(
    `[buyer] Funded escrow ${result.escrow ?? "(not reported)"} for ${terms.worker} over its 402.`,
  );
  opts.telemetry?.stage("escrow_created");
  return result;
}
