// The x402 V2 wire types (x402-foundation/x402 commit 513dd66d2b3eb2388065f9923d81aa496e626082,
// specs/x402-specification-v2.md) and the `on-delivery` and `escro` members carried in them
// (docs/specs/scheme_on_delivery_svm.md, docs/specs/escro-extension.md). Declared once, here.

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  /** Service metadata a discovery catalog lists (x402 `specs/extensions/bazaar.md` at e4a08681). */
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  [member: string]: unknown;
}

/** How a discovery catalog calls an HTTP endpoint: `info.input` of a `bazaar` declaration. */
export interface BazaarHttpInput {
  type: "http";
  method: "GET" | "HEAD" | "DELETE" | "POST" | "PUT" | "PATCH";
  bodyType?: "json" | "form-data" | "text";
  body?: unknown;
  queryParams?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** `extensions.bazaar` of a 402 (x402 `specs/extensions/bazaar.md` at e4a08681). */
export interface BazaarDeclaration {
  info: { input: BazaarHttpInput; output?: { type: string; format?: string; example?: unknown } };
  schema: Record<string, unknown>;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload<P = Record<string, unknown>> {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: P;
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
  /** The amount settled, where the scheme reports one (`upto`). */
  amount?: string;
  extensions?: Record<string, unknown>;
}

/** A facilitator's `/verify` answer. */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

/** One scheme and network a facilitator settles, from its `/supported` answer. */
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/** A facilitator's `/supported` answer. */
export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

/** What a worker's menu settles an `exact` payment through: the SDK's `createHttpFacilitator`, or any equivalent. */
export interface Facilitator {
  verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse>;
  getSupported(): Promise<SupportedResponse>;
}

export type OnDeliveryScheme = "on-delivery" | "job-escrow";

export type SettlementMode = "release" | "refund";

// A type alias, not an interface: an alias is assignable to `PaymentRequirements.extra`'s
// Record<string, unknown> (an interface has no implicit index signature), so
// `OnDeliveryAccept extends PaymentRequirements` type-checks. Readonly: a client never alters
// the terms a 402 offered.
export type OnDeliveryExtra = Readonly<{
  program: string;
  specHash: string;
  specUri: string;
  deadline: number;
  reviewWindowSeconds: number;
  feeBps: number;
  feePayer: "client";
  settlementMode: SettlementMode;
  paymentFlow: "upfront" | "escrow";
}>;

export interface OnDeliveryAccept extends PaymentRequirements {
  scheme: OnDeliveryScheme;
  extra: OnDeliveryExtra;
}

export interface OnDeliveryPayloadFields {
  escrow: string;
  buyer: string;
  taskId: string;
  createSignature: string;
  /** Unix milliseconds. */
  signedAt: number;
  buyerSignature: string;
}

export interface OnDeliveryPaymentPayload extends PaymentPayload<OnDeliveryPayloadFields> {
  accepted: OnDeliveryAccept;
}

/**
 * The `escro` x402 extension's `acceptance` (docs/specs/escro-extension.md "acceptance";
 * `$defs.acceptance` in escro-extension.schema.json): the predicate a judge applies to a delivery.
 * `paramsHash` is the SHA-256 hex of the RFC 8785 canonical JSON of the predicate's parameters.
 */
export interface Acceptance {
  name: string;
  paramsHash: string;
  fixtureHashes?: string[];
}

export interface EscroReceipt {
  schema: string;
  verifierUrl?: string;
}

export interface EscroSettlementTerms {
  reviewWindowSeconds: number;
  settlementMode: SettlementMode;
  feePayer: "client" | "worker";
}

export type EscroNextAction =
  | {
      channel: "onchain";
      action: string;
      actor: string;
      notBefore?: number;
      network: string;
      instruction: string;
      address?: string;
      args?: Record<string, unknown>;
    }
  | {
      channel: "server";
      action: string;
      actor: string;
      notBefore?: number;
      method: "GET" | "POST";
      url: string;
    }
  | {
      channel: "mcp";
      action: string;
      actor: string;
      notBefore?: number;
      server: string;
      tool: string;
      args?: Record<string, unknown>;
    };

export interface EscroExtensionInfo {
  acceptance?: Acceptance;
  receipt?: EscroReceipt;
  settlement?: EscroSettlementTerms;
  nextActions?: EscroNextAction[];
}
