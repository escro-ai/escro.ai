/**
 * The dual-path payment surface: the escrow rail and the x402 rail behind one `pay()`.
 *
 * `pay()` reaches the escrow rail from a 402's `on-delivery` or `job-escrow` entry and
 * the x402 rail from an `exact` entry. Every name here is a FREEZE CONTRACT: a new rail
 * or field must not be a breaking change for any kit-generated bot.
 * The shapes below are pinned by a type-level test; fields are added only as
 * OPTIONAL fields.
 */
import type {
  Acceptance,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettlementResponse,
} from "@escro/shared";

import { EscroPayError, EscroRailNotEnabledError } from "./errors.js";

export { RAILS_DOCS_URL } from "./errors.js";

/** Single source for the rail identifiers. The {@link Rail} type is derived from
 *  this list (drift-safe, mirroring the BOT_ROLES pattern in @escro/shared). */
export const RAILS = ["escrow", "x402"] as const;

/** The payment rails Escro can route across. */
export type Rail = (typeof RAILS)[number];

/** The rails enabled in this build. Typed `readonly Rail[]` (not the literal tuple) so
 *  runtime membership checks stay honest: `ENABLED_RAILS.includes(rail)` narrows nothing
 *  away. */
export const ENABLED_RAILS: readonly Rail[] = ["escrow", "x402"];

/** The minimal payment shape a {@link PaymentRouter} inspects to choose a rail.
 *  FROZEN; the x402 rail may add only optional fields. */
export interface TxShape {
  /** Recipient wallet address (base58). */
  readonly to: string;
  /** Amount to move, in USDC micro-units (integer, 6 decimals). */
  readonly amountMicroUsdc: number;
  /** `async` (verification-needed) work routes to escrow; `sync` work is x402's territory. */
  readonly mode: "async" | "sync";
  /** The 402 entry being paid; its `scheme` routes when `scheme` is absent. */
  readonly accept?: PaymentRequirements;
  /** The x402 scheme being paid; given with `accept`, the two must be equal. */
  readonly scheme?: string;
}

/** Chooses the rail for a payment, throwing rather than return a rail that is not
 *  enabled. FROZEN signature. */
export interface PaymentRouter {
  selectRail(tx: TxShape): Rail;
}

/** The rail an x402 scheme routes to, or undefined for a scheme Escro does not route (exact match:
 *  no case folding or trimming). */
export function railOfScheme(scheme: string): Rail | undefined {
  if (scheme === "on-delivery" || scheme === "job-escrow") return "escrow";
  if (scheme === "exact" || scheme === "upto") return "x402";
  return undefined;
}

/** The mode each rail serves: escrow is asynchronous work, x402 a synchronous payment. */
const RAIL_MODE: Readonly<Record<Rail, TxShape["mode"]>> = { escrow: "async", x402: "sync" };

/**
 * The router. With no scheme, async work routes to escrow and sync work prefers x402, falling back
 * to escrow when x402 is not enabled. With a scheme (`tx.scheme`, else `tx.accept.scheme`),
 * `on-delivery` and `job-escrow` route to escrow under `async`, `exact` and `upto` to x402 under
 * `sync`. It throws {@link EscroPayError} `scheme_conflict` when `scheme` and `accept.scheme`
 * differ or the mode is not the scheme's, `unsupported_scheme` for any other scheme, and
 * {@link EscroRailNotEnabledError} for a scheme whose rail is not enabled: a scheme's rail is never
 * swapped for another.
 */
export class EscrowPaymentRouter implements PaymentRouter {
  selectRail(tx: TxShape): Rail {
    const { scheme, accept } = tx;
    if (scheme !== undefined && accept !== undefined && scheme !== accept.scheme) {
      throw new EscroPayError(
        "scheme_conflict",
        `scheme "${scheme}" is not the accepted entry's scheme "${accept.scheme}"`,
        { detail: scheme },
      );
    }
    const named = scheme ?? accept?.scheme;
    if (named === undefined) {
      const preferred: Rail = tx.mode === "sync" ? "x402" : "escrow";
      return ENABLED_RAILS.includes(preferred) ? preferred : "escrow";
    }
    const rail = railOfScheme(named);
    if (rail === undefined) {
      throw new EscroPayError("unsupported_scheme", `Unsupported x402 scheme "${named}"`, {
        detail: named,
      });
    }
    if (tx.mode !== RAIL_MODE[rail]) {
      throw new EscroPayError(
        "scheme_conflict",
        `Scheme "${named}" is paid in ${RAIL_MODE[rail]} mode, not ${tx.mode}`,
        { detail: named },
      );
    }
    if (!ENABLED_RAILS.includes(rail)) throw new EscroRailNotEnabledError(rail);
    return rail;
  }
}

/** The longest an entry's `maxTimeoutSeconds` may be for {@link Escro.pay} to wait on its paid
 *  request: one hour. An entry over it is not paid. */
export const PAY_MAX_TIMEOUT_SECONDS = 3600;

/** The HTTP request {@link Escro.pay} pays for: sent as given, plus `PAYMENT-SIGNATURE` once paid. */
export interface PayRequest {
  /** Default `GET`. */
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** What a {@link PayPolicy} sees of the 402 beside its entries. */
export interface PayOffer {
  readonly resource: ResourceInfo;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** Chooses the entry to pay from a deep-frozen copy of the 402's `accepts`; it returns one of those
 *  elements. It can only narrow: the entry must still match the caller's `to` and amount. */
export type PayPolicy = (
  accepts: readonly PaymentRequirements[],
  offer: PayOffer,
) => PaymentRequirements;

/** Parameters for {@link Escro.pay}. FROZEN: `to` and `amountMicroUsdc` stay
 *  required and every other field optional; a required field added later would break
 *  every kit-generated bot. Exactly one of `paymentRequired` and `url` is given. */
export interface PayParams {
  /** Recipient wallet address (base58): the only worker paid. */
  readonly to: string;
  /** Amount to pay, in USDC micro-units (integer, 6 decimals): the only amount paid. */
  readonly amountMicroUsdc: number;
  /** A 402 the caller already decoded; the paid request goes to its `resource.url`. */
  readonly paymentRequired?: PaymentRequired;
  /**
   * An absolute http: or https: URL without credentials, requested for its 402. A `url`, or with
   * `paymentRequired` the 402's `resource.url`, on a port `fetch` blocks is refused before any
   * lookup or request.
   */
  readonly url?: string;
  /** The request being paid for; default a bare `GET`. */
  readonly request?: PayRequest;
  /**
   * Chooses among the entries. Absent, the escrow rail wins: when an `on-delivery` or `job-escrow`
   * entry matches the caller's terms an `exact` entry is never paid, whatever the 402's order, and
   * the 402's order decides only within a rail. A policy overrides that.
   */
  readonly policy?: PayPolicy;
  /** Decides an `acceptance` predicate the 402 carries; absent, such a 402 is refused. */
  readonly admitAcceptance?: (acceptance: Acceptance) => boolean;
  /**
   * Decides each address pay() may connect to. Given, pay() resolves each host it requests (the 402's resource, and on
   * the escrow rail the job specification's host) once per call with lookup(host, { all: true }), passes every answer
   * (or the literal address) here with the request's target, and connects only to those answers; an address is admitted
   * only when this returns true, and one refused answer refuses the call.
   */
  readonly admitAddress?: (address: string, target: "resource" | "spec") => boolean;
}

/** Result of a completed payment. FROZEN and rail-generic: `reference` is the
 *  rail-native settlement id (a Solana signature for escrow, an x402 receipt for
 *  x402), so the shape describes either rail without change. */
export interface PaymentResult {
  /** Which rail settled the payment. */
  readonly rail: Rail;
  /** Rail-native settlement reference: on the escrow rail, the `create_escrow` signature; on the
   *  x402 rail, the settlement's transaction. */
  readonly reference: string;
  /** Escrow rail: the escrow's PDA, the handle for `cancelEscrow` and every later call. */
  readonly escrow?: string;
  /** The paid request's `PAYMENT-RESPONSE`, decoded. */
  readonly settlement?: SettlementResponse;
  /** The paid request's response, its body unread. */
  readonly response?: Response;
}
