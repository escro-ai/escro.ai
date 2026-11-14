import type { SettlementResponse } from "@escro/shared";

/** Docs for the payment rails, linked from the rail-not-enabled error and the kit config's rejection
 *  message so both point to the same place. Re-exported from `payments.ts`. */
export const RAILS_DOCS_URL = "https://escro.ai/rails";

/**
 * Base class for all errors thrown by the @escro/sdk. `retryAfterMs` is the
 * server's Retry-After delay, when it sent one in seconds; `options.cause` is the
 * failure this error reports.
 */
export class EscroError extends Error {
  constructor(
    message: string,
    public readonly code = "ESCRO_ERROR",
    public readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "EscroError";
  }
}

/** The requested escrow was not found (HTTP 404). */
export class EscrowNotFoundError extends EscroError {
  constructor(address: string) {
    super(`Escrow not found: ${address}`, "ESCROW_NOT_FOUND");
    this.name = "EscrowNotFoundError";
  }
}

/**
 * The reputation endpoint is not available on this deployment (HTTP 404). A 404
 * from `GET /rep` means no `ReputationSource` is mounted (the surface is
 * unmounted), NOT that a wallet is unknown - unknown wallets return zeroed raw
 * components, never a 404. Kept distinct from {@link EscrowNotFoundError}, whose
 * 404 is about a missing escrow.
 */
export class ReputationUnavailableError extends EscroError {
  constructor() {
    super(
      "Reputation endpoint is unavailable (HTTP 404): this deployment has no reputation source mounted.",
      "REPUTATION_UNAVAILABLE",
    );
    this.name = "ReputationUnavailableError";
  }
}

/** The operation is not valid for the escrow's current state (HTTP 409). */
export class EscrowStateError extends EscroError {
  constructor(message: string) {
    super(message, "ESCROW_INVALID_STATE");
    this.name = "EscrowStateError";
  }
}

/** Polling timed out after 24 hours without reaching the expected state. */
export class EscrowTimeoutError extends EscroError {
  constructor(address: string) {
    super(`Polling timed out after 24h for escrow: ${address}`, "ESCROW_TIMEOUT");
    this.name = "EscrowTimeoutError";
  }
}

/**
 * A transaction landed (or was sent) but the API did not record it. `code` is the
 * server's code (e.g. TX_MISMATCH, TX_FAILED, or TX_NOT_FOUND after the retry
 * window), `NETWORK_ERROR` when the last attempt never reached the API, or
 * `HTTP_<status>` when the answer carried no code. Call {@link Escro.confirm} again
 * with `address` and `signature` to retry, no sooner than `retryAfterMs` when the
 * API sent one.
 */
export class EscroConfirmError extends EscroError {
  constructor(
    public readonly address: string,
    public readonly signature: string,
    code: string,
    message: string,
    retryAfterMs?: number,
  ) {
    super(
      `Confirm failed for escrow ${address} (signature ${signature}): ${message}`,
      code,
      retryAfterMs,
    );
    this.name = "EscroConfirmError";
  }
}

/** The caller is not authorized to perform this action (HTTP 401/403). */
export class UnauthorizedError extends EscroError {
  constructor(message = "Unauthorized") {
    super(message, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/**
 * A payment rail is not available. {@link Escro.pay} throws this for the `x402` rail when its
 * packages fail to load (`cause` is the load failure); nothing was signed and nothing is counted.
 * `rail` names the unavailable rail.
 */
export class EscroRailNotEnabledError extends EscroError {
  constructor(
    public readonly rail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Payment rail "${rail}" is not available in this installation. See ${RAILS_DOCS_URL}`,
      "ESCRO_RAIL_NOT_ENABLED",
      undefined,
      options,
    );
    this.name = "EscroRailNotEnabledError";
  }
}

/**
 * Sets an own property on a thrown value and leaves the value itself alone: its class, name and
 * message stay what a classifier reads. A non-object, or a frozen one, is left as it is.
 */
export function attachToError(err: unknown, field: string, value: string): void {
  if (typeof err !== "object" || err === null) return;
  Reflect.defineProperty(err, field, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Why {@link Escro.pay} refused a payment; see {@link EscroPayError}. */
export type PayRefusal =
  | "no_offer"
  | "both_offers"
  | "url"
  | "request_header"
  | "request"
  | "redirect"
  | "not_402"
  | "resource_mismatch"
  | "no_eligible_entry"
  | "timeout_ceiling"
  | "policy_choice"
  | "unsupported_scheme"
  | "scheme_conflict"
  | "presentation"
  | "settlement"
  | "timeout"
  | "requirements"
  | "transaction"
  | "host";

/**
 * {@link Escro.pay} refused, or the payment router refused a scheme; `reason` names the check and
 * `detail` the offending value where there is one. Once the escrow is created, `escrowPda` and
 * `createSignature` are set: the escrow is funded, and `cancelEscrow(escrowPda)` recovers the
 * deposit while it is Funded. `status` is the paid request's HTTP status when it answered. On the
 * x402 rail a failure after the payment left the process carries `payment`, and no `escrowPda`. A
 * paid request answered with an error status carries `settlement` when the answer's
 * `PAYMENT-RESPONSE` decodes with a boolean `success` and a string `transaction` and `network`:
 * the worker's own unverified report, whatever its `success`.
 */
export class EscroPayError extends EscroError {
  readonly reason: PayRefusal;
  readonly detail?: string;
  readonly escrowPda?: string;
  readonly createSignature?: string;
  readonly status?: number;
  /**
   * What a failed x402 settlement can be matched by against the wallet's token-account history, in
   * case the resource server still lands the transfer: the Memo instruction's text (byte-exact),
   * the amount and `payTo`. Never the partially signed transaction.
   */
  readonly payment?: {
    readonly memo: string;
    readonly amountMicroUsdc: number;
    readonly payTo: string;
  };
  /** The `PAYMENT-RESPONSE` a worker sent beside an error status: its unverified word, as sent. */
  readonly settlement?: SettlementResponse;

  constructor(
    reason: PayRefusal,
    message: string,
    options: {
      detail?: string;
      escrowPda?: string;
      createSignature?: string;
      status?: number;
      payment?: EscroPayError["payment"];
      settlement?: SettlementResponse;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      "PAY_REFUSED",
      undefined,
      "cause" in options ? { cause: options.cause } : undefined,
    );
    this.name = "EscroPayError";
    this.reason = reason;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.escrowPda !== undefined) this.escrowPda = options.escrowPda;
    if (options.createSignature !== undefined) this.createSignature = options.createSignature;
    if (options.status !== undefined) this.status = options.status;
    if (options.payment !== undefined) this.payment = options.payment;
    if (options.settlement !== undefined) this.settlement = options.settlement;
  }
}
