// The x402 V2 HTTP transport headers (x402-foundation/x402 commit
// 513dd66d2b3eb2388065f9923d81aa496e626082, specs/transports-v2/http.md): standard RFC 4648 base64,
// with padding, of the UTF-8 bytes of the JSON value. One codec serves every rail.
import {
  isRecord,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "@escro/shared";

import { X402CodecError } from "./errors.js";

/** The three x402 V2 HTTP header names. */
export const X402_HEADERS = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
} as const;

const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** The JSON object a header carries; throws X402CodecError on anything else. */
function decodeObject(header: string, what: string): Record<string, unknown> {
  if (!STANDARD_BASE64.test(header)) {
    throw new X402CodecError(`The ${what} header is not padded standard base64`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(header, "base64"));
  } catch (cause) {
    throw new X402CodecError(`The ${what} header is not UTF-8`, { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new X402CodecError(`The ${what} header is not JSON`, { cause });
  }
  if (!isRecord(value)) throw new X402CodecError(`The ${what} header is not a JSON object`);
  return value;
}

function requireVersion2(value: Record<string, unknown>, what: string): void {
  if (value.x402Version !== 2) throw new X402CodecError(`The ${what} header is not x402Version 2`);
}

/** A 402's `PAYMENT-REQUIRED` header value. */
export function encodePaymentRequired(value: PaymentRequired): string {
  return encode(value);
}

/**
 * A `PAYMENT-REQUIRED` header's value, checked for version 2, `resource.url` and each entry's
 * `scheme` and `network`; throws {@link X402CodecError} otherwise.
 */
export function decodePaymentRequired(header: string): PaymentRequired {
  const what = X402_HEADERS.paymentRequired;
  const value = decodeObject(header, what);
  requireVersion2(value, what);
  if (!isRecord(value.resource) || typeof value.resource.url !== "string") {
    throw new X402CodecError(`The ${what} header has no resource.url`);
  }
  const accepts = value.accepts;
  if (!Array.isArray(accepts)) throw new X402CodecError(`The ${what} header has no accepts array`);
  for (const entry of accepts) {
    if (!isRecord(entry) || typeof entry.scheme !== "string" || typeof entry.network !== "string") {
      throw new X402CodecError(
        `The ${what} header has an accepts entry without scheme and network`,
      );
    }
  }
  return value as unknown as PaymentRequired;
}

/** A payment's `PAYMENT-SIGNATURE` header value. */
export function encodePaymentSignature(value: PaymentPayload): string {
  return encode(value);
}

/**
 * A `PAYMENT-SIGNATURE` header's value, checked for version 2 and the `accepted` and `payload`
 * objects; throws {@link X402CodecError} otherwise.
 */
export function decodePaymentSignature(header: string): PaymentPayload {
  const what = X402_HEADERS.paymentSignature;
  const value = decodeObject(header, what);
  requireVersion2(value, what);
  if (!isRecord(value.accepted) || !isRecord(value.payload)) {
    throw new X402CodecError(`The ${what} header has no accepted or payload object`);
  }
  return value as unknown as PaymentPayload;
}

/** A settlement's `PAYMENT-RESPONSE` header value. */
export function encodePaymentResponse(value: SettlementResponse): string {
  return encode(value);
}

/**
 * A `PAYMENT-RESPONSE` header's value, checked for a boolean `success`; throws
 * {@link X402CodecError} otherwise.
 */
export function decodePaymentResponse(header: string): SettlementResponse {
  const what = X402_HEADERS.paymentResponse;
  const value = decodeObject(header, what);
  if (typeof value.success !== "boolean") {
    throw new X402CodecError(`The ${what} header has no boolean success`);
  }
  return value as unknown as SettlementResponse;
}
