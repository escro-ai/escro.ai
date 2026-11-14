import { EscroError } from "../errors.js";

/** A `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` or `PAYMENT-RESPONSE` header that is not the x402 V2 encoding. */
export class X402CodecError extends EscroError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "X402_CODEC", undefined, options);
    this.name = "X402CodecError";
  }
}

/** No PlatformConfig account at the cluster's PlatformConfig PDA. */
export class PlatformConfigNotFoundError extends EscroError {
  constructor(address: string) {
    super(`No PlatformConfig account at ${address}`, "PLATFORM_CONFIG_NOT_FOUND");
    this.name = "PlatformConfigNotFoundError";
  }
}

/** Why an `on-delivery` entry was not selected (docs/specs/scheme_on_delivery_svm.md, client checks). */
export type OnDeliveryAcceptRefusal =
  | "no_entry"
  | "network"
  | "program"
  | "asset"
  | "fee_bps"
  | "settlement_mode"
  | "review_window"
  | "fee_payer"
  | "payment_flow"
  | "amount"
  | "over_limit"
  | "pay_to"
  | "spec_hash"
  | "spec_uri"
  | "deadline"
  | "max_timeout"
  | "extra_shape"
  | "extension_invalid"
  | "extension_terms"
  | "acceptance";

/**
 * No acceptable `on-delivery` entry. `refusals` lists each candidate's first refusal; `index` is the
 * entry's index in `accepts`, or -1 where no entry is concerned (`no_entry`, an `escro` extension
 * parsed alone, an entry `buildEscrowAccept` refused to build).
 */
export class OnDeliveryAcceptError extends EscroError {
  readonly refusals: readonly { index: number; reason: OnDeliveryAcceptRefusal }[];

  constructor(refusals: readonly { index: number; reason: OnDeliveryAcceptRefusal }[]) {
    const listed = refusals.map((r) => `${String(r.index)}: ${r.reason}`).join(", ");
    super(`No acceptable on-delivery entry (${listed})`, "ON_DELIVERY_ACCEPT_REFUSED");
    this.name = "OnDeliveryAcceptError";
    this.refusals = refusals;
  }
}

export type OnDeliveryFundRefusal =
  | "selection_unknown"
  | "selection_spent"
  | "resource_url"
  | "resource_mismatch"
  | "spec_fetch"
  | "spec_host"
  | "spec_hash_mismatch"
  | "spec_refused"
  | "escrow_mismatch";

/** `fundFromAccept` or `fetchTaskSpec` refused; `reason` names the check. */
export class OnDeliveryFundError extends EscroError {
  readonly reason: OnDeliveryFundRefusal;
  /** Set on `escrow_mismatch` only: the create landed; recover with `Escro.cancelEscrow(escrowPda)`. */
  readonly escrowId?: string;
  readonly escrowPda?: string;
  readonly signature?: string;

  constructor(
    reason: OnDeliveryFundRefusal,
    message: string,
    options: { cause?: unknown; escrowId?: string; escrowPda?: string; signature?: string } = {},
  ) {
    super(
      message,
      "ON_DELIVERY_FUND_REFUSED",
      undefined,
      "cause" in options ? { cause: options.cause } : undefined,
    );
    this.name = "OnDeliveryFundError";
    this.reason = reason;
    if (options.escrowId !== undefined) this.escrowId = options.escrowId;
    if (options.escrowPda !== undefined) this.escrowPda = options.escrowPda;
    if (options.signature !== undefined) this.signature = options.signature;
  }
}

/** The facilitator operation an {@link EscroFacilitatorError} failed in. */
export type FacilitatorOperation = "verify" | "settle" | "supported";

/**
 * A facilitator call that failed with no answer: unreachable, timed out, an unrecognised error, or its client not
 * loadable. `indeterminate` is set on every `settle` failure: the facilitator may still have sent the transfer. The
 * message holds no part of the facilitator URL, and the error carries no `cause`.
 */
export class EscroFacilitatorError extends EscroError {
  readonly operation: FacilitatorOperation;
  readonly indeterminate: boolean;

  constructor(operation: FacilitatorOperation, message: string) {
    super(message, "FACILITATOR_UNAVAILABLE");
    this.name = "EscroFacilitatorError";
    this.operation = operation;
    this.indeterminate = operation === "settle";
  }
}

/** Why {@link buildExactAccept} refused to build an `exact` entry. */
export type ExactAcceptRefusal = "pay_to" | "fee_payer" | "amount" | "max_timeout";

/** The worker's `exact` entry would be one a buyer cannot pay or a facilitator cannot settle in time. */
export class ExactAcceptError extends EscroError {
  readonly reason: ExactAcceptRefusal;

  constructor(reason: ExactAcceptRefusal, message: string) {
    super(message, "EXACT_ACCEPT_REFUSED");
    this.name = "ExactAcceptError";
    this.reason = reason;
  }
}
