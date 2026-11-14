// A facilitator over HTTP: @x402/core's HTTPFacilitatorClient, at the SDK's exact pin, reached only through the one
// lazy import below, so a process that never settles an `exact` payment never executes it. Its refusals that carry an
// answer resolve as that answer; every other failure is an EscroFacilitatorError with the URL redacted.
import {
  redactRpcUrl,
  type Facilitator,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@escro/shared";
import type {
  PaymentPayload as CorePaymentPayload,
  PaymentRequirements as CorePaymentRequirements,
} from "@x402/core/types";
import type { HTTPFacilitatorClient } from "@x402/core/http";

import { EscroFacilitatorError, type FacilitatorOperation } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const URL_RULE =
  "A facilitator URL must be an https: URL with no username, password, query or fragment";

export interface HttpFacilitatorOptions {
  /** `https:`, with no userinfo, query or fragment; a path is allowed. */
  url: string;
  /** Per request. Default 30 000. */
  timeoutMs?: number;
}

/** Throws a TypeError naming the rule, never the URL. */
function requireFacilitatorUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(URL_RULE);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.href.includes("?") ||
    parsed.href.includes("#")
  ) {
    throw new TypeError(URL_RULE);
  }
}

const isError = (value: unknown): value is Error & Record<string, unknown> =>
  value instanceof Error;

const stringMember = (value: Record<string, unknown>, name: string): string | undefined => {
  const member = value[name];
  return typeof member === "string" ? member : undefined;
};

/**
 * A facilitator at `url`. Synchronous and offline: the client is loaded and built on the first call, once per
 * facilitator. Throws a TypeError, naming the rule and never the URL, for a URL that is not `https:` or carries a
 * username, password, query or fragment.
 */
export function createHttpFacilitator(options: HttpFacilitatorOptions): Facilitator {
  const { url } = options;
  requireFacilitatorUrl(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let client: Promise<HTTPFacilitatorClient> | undefined;

  const load = (): Promise<HTTPFacilitatorClient> => {
    if (client !== undefined) return client;
    const loading = import("@x402/core/http").then(
      (http) => new http.HTTPFacilitatorClient({ url, timeoutMs }),
    );
    // A failed load is retried by the next call, not remembered.
    loading.catch(() => {
      if (client === loading) client = undefined;
    });
    client = loading;
    return loading;
  };

  const unavailable = (operation: FacilitatorOperation, err: unknown): EscroFacilitatorError => {
    const upstream = isError(err) ? err.message : String(err);
    return new EscroFacilitatorError(
      operation,
      `The facilitator's ${operation} failed: ${redactRpcUrl(upstream, [url], "<facilitatorUrl>")}`,
    );
  };

  return {
    async verify(payment: PaymentPayload, requirements: PaymentRequirements) {
      try {
        const http = await load();
        const answer: VerifyResponse = await http.verify(
          payment as CorePaymentPayload,
          requirements as CorePaymentRequirements,
        );
        return answer;
      } catch (err) {
        const invalidReason = isError(err) ? stringMember(err, "invalidReason") : undefined;
        if (isError(err) && err.name === "VerifyError" && invalidReason !== undefined) {
          return { isValid: false, invalidReason };
        }
        throw unavailable("verify", err);
      }
    },
    async settle(payment: PaymentPayload, requirements: PaymentRequirements) {
      try {
        const http = await load();
        const answer: SettlementResponse = await http.settle(
          payment as CorePaymentPayload,
          requirements as CorePaymentRequirements,
        );
        return answer;
      } catch (err) {
        const errorReason = isError(err) ? stringMember(err, "errorReason") : undefined;
        if (isError(err) && err.name === "SettleError" && errorReason !== undefined) {
          // A pending settlement's signature is kept: the transfer may already have been sent.
          return {
            success: false,
            errorReason,
            transaction: stringMember(err, "transaction") ?? "",
            network: stringMember(err, "network") ?? "",
          };
        }
        throw unavailable("settle", err);
      }
    },
    async getSupported() {
      try {
        const http = await load();
        const answer: SupportedResponse = await http.getSupported();
        return answer;
      } catch (err) {
        throw unavailable("supported", err);
      }
    },
  };
}
