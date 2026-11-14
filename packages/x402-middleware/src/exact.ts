// A route's `exact` leg: the worker's own `exact` entry, offered beside `on-delivery`, settled through the injected
// facilitator and answered with the work inside the paid request. The facilitator receives only the entry this module
// rebuilds, the payload's transaction and the route's own resource and `bazaar` declaration, never what the buyer
// echoed; the worker signs nothing and no Escro surface is reached.
import {
  ExactAcceptError,
  X402_HEADERS,
  buildExactAccept,
  encodePaymentResponse,
  exactFeePayer,
  type BazaarDeclaration,
  type Facilitator,
  type PaymentPayload,
  type PaymentRequirements,
  type ReplayStore,
  type ResourceInfo,
  type SettlementResponse,
  type TaskSpec,
  type VerifyResponse,
} from "@escro/sdk";

import type { MenuCluster, MenuRequest, SettleExactRoute } from "./index.js";

/** How long an unpaid request waits for a `/supported` read in flight before offering `on-delivery` alone. */
const OFFER_WAIT_MS = 2_000;
/** How long a failed `/supported` read is remembered before the next one. */
const FAILURE_MEMORY_MS = 30_000;
/** The answer is due one second before the buyer's window closes, so it reaches the buyer inside it. */
const ANSWER_MARGIN_MS = 1_000;
const REASON = /^[a-z0-9_]{1,64}$/;
const PENDING = "settlement_pending";

/** A route's `exact` leg with its defaults applied. */
export interface ExactServed {
  config: SettleExactRoute;
  maxTimeoutSeconds: number;
}

/** What the leg answers: a response of its own, or a fresh 402 the menu builds (with or without the `exact` entry). */
export type ExactOutcome =
  | {
      kind: "answer";
      status: number;
      headers: Record<string, string>;
      body: string | Uint8Array;
    }
  | { kind: "offer"; error: string; exact: boolean; headers: Record<string, string> };

export interface ExactLegOptions {
  facilitator: Facilitator;
  cluster: MenuCluster;
  payTo: string;
  replay: ReplayStore;
  now: () => number;
  /** How long a successful `/supported` read is reused. */
  cacheMs: number;
  /** Added to each replay key's hold past the entry's window. */
  holdMs: number;
}

export interface ExactPaid {
  served: ExactServed;
  payment: PaymentPayload;
  spec: TaskSpec;
  request: MenuRequest;
  /** The route's own 402 resource. */
  resource: ResourceInfo;
  /** The route's own declaration, forwarded as `extensions.bazaar`. */
  bazaar?: BazaarDeclaration;
  /** The request's arrival, Unix ms. */
  arrival: number;
}

const answer = (
  status: number,
  error: string,
  headers: Record<string, string> = {},
): ExactOutcome => ({
  kind: "answer",
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ error }),
});

const offer = (
  error: string,
  exact: boolean,
  headers: Record<string, string> = {},
): ExactOutcome => ({ kind: "offer", error, exact, headers });

/** `reason` when it is a plain code, else `fallback`: a facilitator's free text never reaches the buyer. */
const reasonOr = (reason: unknown, fallback: string): string =>
  typeof reason === "string" && REASON.test(reason) ? reason : fallback;

/** Same keys and same values, recursively; key order aside. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]),
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `promise`'s value, or `fallback` once `ms` has passed. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(
      () => {
        resolve(fallback);
      },
      Math.max(0, ms),
    );
  });
  return Promise.race([promise, late]).finally(() => {
    clearTimeout(timer);
  });
}

/** A settle answer naming a transaction: the facilitator sent one. */
const hasSignature = (settlement: SettlementResponse): boolean => {
  const { transaction } = settlement as { transaction: unknown };
  return transaction !== "" && transaction !== undefined;
};

/**
 * A facilitator's answer is the operator's injected object or untrusted JSON: only the literal `true` is a yes, never a
 * truthy stand-in.
 */
const isTrue = (value: unknown): boolean => value === true;

interface Served {
  kind: "served";
  answer: { contentType: string; body: string | Uint8Array };
}
type ServeResult = Served | { kind: "failed" } | { kind: "late" };

export class ExactLeg {
  /** The last fee payer `/supported` named, and when; current while younger than `cacheMs`. */
  private last: { feePayer: string; at: number } | undefined;
  /** The fee payer a refresh replaced, and when. */
  private previous: { feePayer: string; changedAt: number } | undefined;
  private failedAt: number | undefined;
  private reading: Promise<string | undefined> | undefined;

  constructor(private readonly o: ExactLegOptions) {}

  /** The route's entry under the current fee payer, read or awaited for at most 2 s; undefined without one. */
  async offered(served: ExactServed): Promise<PaymentRequirements | undefined> {
    const feePayer = await this.feePayer(OFFER_WAIT_MS);
    return feePayer === undefined ? undefined : this.entry(served, feePayer);
  }

  /** The route's entry under a current fee payer already known; never reads. */
  known(served: ExactServed): PaymentRequirements | undefined {
    const feePayer = this.current(this.o.now());
    return feePayer === undefined ? undefined : this.entry(served, feePayer);
  }

  /** A paid `exact` request, from the fee payer through the settle to the work (the spec's outcome table). */
  async settle(paid: ExactPaid): Promise<ExactOutcome> {
    const { served, payment, spec, request } = paid;
    const deadline = paid.arrival + served.maxTimeoutSeconds * 1_000 - ANSWER_MARGIN_MS;
    const current = await this.feePayer(deadline - this.o.now());
    const feePayers = [current, this.previousAt(served, this.o.now())].filter(
      (f): f is string => f !== undefined,
    );
    if (feePayers.length === 0) return offer("exact_unavailable", false);
    const entry = feePayers
      .map((feePayer) => this.entry(served, feePayer))
      .find((candidate) => sameValue(payment.accepted, candidate));
    if (entry === undefined) return offer("invalid_exact_accepted", true);
    const { transaction } = payment.payload;
    if (typeof transaction !== "string" || transaction === "") {
      return offer("invalid_exact_payload", true);
    }
    const holdUntil = (): number => this.o.now() + served.maxTimeoutSeconds * 1_000 + this.o.holdMs;
    const payloadKey = `exact:${await sha256Hex(transaction)}`;
    if (!(await this.o.replay.claim(payloadKey, holdUntil(), this.o.now()))) {
      return answer(409, "exact_payment_replayed");
    }
    const forwarded: PaymentPayload = {
      x402Version: 2,
      resource: paid.resource,
      accepted: entry,
      payload: { transaction },
      ...(paid.bazaar === undefined ? {} : { extensions: { bazaar: paid.bazaar } }),
    };

    let verdict: VerifyResponse;
    try {
      verdict = await this.o.facilitator.verify(forwarded, entry);
    } catch {
      console.error("The facilitator's verify failed");
      return answer(503, "facilitator_unavailable");
    }
    if (!isTrue(verdict.isValid)) {
      return offer(reasonOr(verdict.invalidReason, "invalid_exact_payment"), true);
    }
    if (this.o.now() >= deadline) return answer(504, "exact_deadline_passed");

    const settled = await this.settleEntry(forwarded, entry);
    if (settled.kind === "unknown") return answer(504, "exact_settlement_unknown");
    if (settled.kind === "failed") {
      const failed: SettlementResponse = {
        success: false,
        transaction: "",
        network: entry.network,
        errorReason: settled.reason,
      };
      return offer(settled.reason, true, {
        [X402_HEADERS.paymentResponse]: encodePaymentResponse(failed),
      });
    }
    const settlement = settled.settlement;
    if (
      typeof settlement.transaction !== "string" ||
      settlement.transaction === "" ||
      settlement.network !== entry.network ||
      (settlement.amount !== undefined && settlement.amount !== entry.amount)
    ) {
      return answer(502, "exact_settlement_invalid");
    }
    const proof: SettlementResponse = {
      success: true,
      transaction: settlement.transaction,
      network: entry.network,
      ...(typeof settlement.payer === "string" ? { payer: settlement.payer } : {}),
    };
    const paidHeader = { [X402_HEADERS.paymentResponse]: encodePaymentResponse(proof) };
    let claimed: boolean;
    try {
      claimed = await this.o.replay.claim(
        `exact-tx:${settlement.transaction}`,
        holdUntil(),
        this.o.now(),
      );
    } catch {
      // The transfer is settled: the buyer keeps its proof and the work does not run unclaimed.
      console.error("The replay store failed after a settled payment");
      return answer(500, "exact_service_failed", paidHeader);
    }
    if (!claimed) return answer(409, "exact_payment_replayed");
    if (this.o.now() >= deadline) return answer(504, "exact_service_timeout", paidHeader);

    const work = await this.serve(served, { request, taskSpec: spec }, deadline);
    if (work.kind === "late") return answer(504, "exact_service_timeout", paidHeader);
    if (work.kind === "failed") return answer(500, "exact_service_failed", paidHeader);
    return {
      kind: "answer",
      status: 200,
      headers: { "content-type": work.answer.contentType, ...paidHeader },
      body: work.answer.body,
    };
  }

  /**
   * One settle, and one more for an answer that says the transfer was sent and is unconfirmed. A transfer with a
   * signature is never a definite failure: the menu does not read the chain, so it cannot tell one that failed from one
   * that may still land.
   */
  private async settleEntry(
    forwarded: PaymentPayload,
    entry: PaymentRequirements,
  ): Promise<
    | { kind: "settled"; settlement: SettlementResponse }
    | { kind: "failed"; reason: string }
    | { kind: "unknown" }
  > {
    let settlement: SettlementResponse;
    try {
      settlement = await this.o.facilitator.settle(forwarded, entry);
      if (
        !isTrue(settlement.success) &&
        settlement.errorReason === PENDING &&
        hasSignature(settlement)
      ) {
        settlement = await this.o.facilitator.settle(forwarded, entry);
        if (!isTrue(settlement.success)) return { kind: "unknown" };
      }
    } catch {
      console.error("The facilitator's settle failed; the payment may have been sent");
      return { kind: "unknown" };
    }
    if (isTrue(settlement.success)) return { kind: "settled", settlement };
    if (hasSignature(settlement)) return { kind: "unknown" };
    return { kind: "failed", reason: reasonOr(settlement.errorReason, "exact_settlement_failed") };
  }

  /** Runs the route's work once, aborting it at the deadline. */
  private async serve(
    served: ExactServed,
    job: { request: MenuRequest; taskSpec: TaskSpec },
    deadline: number,
  ): Promise<ServeResult> {
    const controller = new AbortController();
    const work: Promise<ServeResult> = Promise.resolve()
      .then(() => served.config.serve(job, controller.signal))
      .then(
        (result): ServeResult => ({ kind: "served", answer: result }),
        (err: unknown): ServeResult => {
          // The operator's own error; no facilitator text reaches this path.
          console.error(
            `A paid exact request's work failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { kind: "failed" };
        },
      );
    const result = await within<ServeResult>(work, deadline - this.o.now(), { kind: "late" });
    if (result.kind === "late") controller.abort();
    return result;
  }

  private entry(served: ExactServed, feePayer: string): PaymentRequirements {
    return buildExactAccept({
      cluster: this.o.cluster,
      amountMicroUsdc: served.config.priceMicroUsdc,
      payTo: this.o.payTo,
      feePayer,
      maxTimeoutSeconds: served.maxTimeoutSeconds,
    });
  }

  private current(at: number): string | undefined {
    return this.last !== undefined && at < this.last.at + this.o.cacheMs
      ? this.last.feePayer
      : undefined;
  }

  /** The fee payer a refresh replaced, while a 402 issued before it can still be paid. */
  private previousAt(served: ExactServed, at: number): string | undefined {
    const previous = this.previous;
    if (previous === undefined) return undefined;
    return at <= previous.changedAt + served.maxTimeoutSeconds * 1_000
      ? previous.feePayer
      : undefined;
  }

  /** The current fee payer, reading `/supported` (one read at a time) and waiting at most `waitMs` for it. */
  private feePayer(waitMs: number): Promise<string | undefined> {
    const at = this.o.now();
    const current = this.current(at);
    if (current !== undefined) return Promise.resolve(current);
    if (this.failedAt !== undefined && at < this.failedAt + FAILURE_MEMORY_MS) {
      return Promise.resolve(undefined);
    }
    this.reading ??= this.read().finally(() => {
      this.reading = undefined;
    });
    return within(this.reading, waitMs, undefined);
  }

  private async read(): Promise<string | undefined> {
    let feePayer: string | undefined;
    try {
      feePayer = exactFeePayer(await this.o.facilitator.getSupported(), this.o.cluster);
    } catch {
      console.error("The facilitator's /supported read failed");
      feePayer = undefined;
    }
    if (feePayer !== undefined && !this.admissible(feePayer)) feePayer = undefined;
    const at = this.o.now();
    if (feePayer === undefined) {
      this.failedAt = at;
      return undefined;
    }
    this.failedAt = undefined;
    if (this.last !== undefined && this.last.feePayer !== feePayer) {
      this.previous = { feePayer: this.last.feePayer, changedAt: at };
    }
    this.last = { feePayer, at };
    return feePayer;
  }

  /** A fee payer that is a canonical key and not the worker itself. */
  private admissible(feePayer: string): boolean {
    try {
      buildExactAccept({
        cluster: this.o.cluster,
        amountMicroUsdc: 1n,
        payTo: this.o.payTo,
        feePayer,
        maxTimeoutSeconds: 10,
      });
      return true;
    } catch (err) {
      if (err instanceof ExactAcceptError) return false;
      throw err;
    }
  }
}
