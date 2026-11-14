// Paying a 402 (docs/specs/scheme_on_delivery_svm.md, "Client, before funding"): one offer, the
// caller's own terms, then either the on-delivery selection and funding of accept.ts and fund.ts or
// the `exact` payment of exact.ts, and one paid request to the URL that answered.
import type { LookupAddress } from "node:dns";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  escrowFee,
  getCaip2Network,
  isRecord,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
  type SolanaCluster,
} from "@escro/shared";
import { isCanonicalPubkey } from "@escro/shared/solana";

import type { Escro } from "../client.js";
import { EscroError, EscroPayError, EscroRailNotEnabledError } from "../errors.js";
import {
  ENABLED_RAILS,
  PAY_MAX_TIMEOUT_SECONDS,
  railOfScheme,
  type PayOffer,
  type PayParams,
  type PaymentResult,
  type PaymentRouter,
  type TxShape,
} from "../payments.js";
import { admitX402Payment } from "../spend-cap.js";
import type { X402SpendCap } from "../types.js";
import { deepFreeze, parseEscrowAccept, readPlatformConfig } from "./accept.js";
import { X402CodecError } from "./errors.js";
import { checkExactRequirements, exactPayload } from "./exact.js";
import { fundSelection } from "./fund.js";
import {
  X402_HEADERS,
  decodePaymentRequired,
  decodePaymentResponse,
  encodePaymentRequired,
  encodePaymentSignature,
} from "./headers.js";
import {
  callResolver,
  isBadPortUrl,
  judge,
  pinnedRequest,
  untilAborted,
  type HostResolver,
} from "./pinned-request.js";

const FIRST_REQUEST_TIMEOUT_MS = 30_000;

// RFC 9110 section 5.6.2.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// The methods fetch refuses to send.
const FORBIDDEN_METHODS: readonly string[] = ["CONNECT", "TRACE", "TRACK"];

export interface PayOver402Deps {
  escro: Pick<Escro, "createEscrow">;
  wallet: Keypair;
  cluster: SolanaCluster;
  rpc: Pick<Connection, "getAccountInfo">;
  router: PaymentRouter;
  /** The client's own RPC URL, the only one the x402 scheme client reads through. */
  rpcUrl: string;
  /** Frozen at construction; absent means no x402 budget, which mainnet refuses. */
  x402SpendCap?: Readonly<X402SpendCap> | undefined;
}

type Offer = { decoded: PaymentRequired } | { url: string };

interface RequestParts {
  method: string;
  /** Copied into each request's own Headers; never sent itself. */
  headers: Headers;
  body: string | undefined;
  /** The resource host's admitted answers, when the caller gave an address rule; absent, fetch. */
  pin?: readonly LookupAddress[];
}

/** The caller's address rule and the call's one resolution of each host. */
interface Pinning {
  rule: NonNullable<PayParams["admitAddress"]>;
  resolve: HostResolver;
}

/** The escrow a refusal after the create names, so the caller can cancel it. */
interface Handle {
  escrowPda: string;
  createSignature: string;
}

/** What a refusal after an x402 payment left the process names, to match against chain. */
type X402Handle = Required<Pick<EscroPayError, "payment">>;

/**
 * The arguments, checked in this order before any network, RPC or API call and before the 402 is
 * read: the terms, the offer, the URL, the request's headers, the request's method and body. A
 * request fetch would refuse is refused here, so it never fails after the escrow is funded.
 */
function checkArguments(params: PayParams): { offer: Offer; parts: RequestParts } {
  if (!isCanonicalPubkey(params.to)) {
    throw new EscroError(
      `to must be a base-58 public key: ${JSON.stringify(params.to)}`,
      "VALIDATION_ERROR",
    );
  }
  if (!Number.isSafeInteger(params.amountMicroUsdc) || params.amountMicroUsdc <= 0) {
    throw new EscroError(
      `amountMicroUsdc must be a positive whole micro-USDC amount: ${String(params.amountMicroUsdc)}`,
      "VALIDATION_ERROR",
    );
  }
  const { paymentRequired, url } = params;
  if (paymentRequired !== undefined && url !== undefined) {
    throw new EscroPayError(
      "both_offers",
      "pay() takes one offer: give paymentRequired or url, not both",
    );
  }
  const offer: Offer | undefined =
    paymentRequired !== undefined
      ? { decoded: paymentRequired }
      : url !== undefined
        ? { url }
        : undefined;
  if (offer === undefined) {
    throw new EscroPayError("no_offer", "pay() needs a 402 to pay: give paymentRequired or url");
  }
  if ("url" in offer && !isPayableUrl(offer.url)) {
    throw new EscroPayError(
      "url",
      "url must be an absolute http: or https: URL without credentials",
    );
  }
  if ("url" in offer && isBadPortUrl(new URL(offer.url))) {
    throw new EscroPayError("url", "url names a port fetch blocks");
  }
  const request = params.request ?? {};
  const headers: unknown = request.headers ?? {};
  if (!isPlainRecord(headers)) {
    throw new EscroPayError("request_header", "request.headers must be a plain object record", {
      detail: "not_record",
    });
  }
  // The copy is what every request sends, so the name check reads the copy, never the caller's object again.
  let validated: Headers;
  try {
    validated = new Headers(headers);
  } catch (cause) {
    throw new EscroPayError(
      "request_header",
      "request.headers holds a name or value fetch refuses",
      {
        cause,
      },
    );
  }
  if (validated.has(X402_HEADERS.paymentSignature)) {
    // Only the message's detail reads the caller's keys; the copy has already decided.
    const named = Object.keys(headers).find(
      (name) => name.toLowerCase() === X402_HEADERS.paymentSignature.toLowerCase(),
    );
    throw new EscroPayError("request_header", "request.headers may not carry PAYMENT-SIGNATURE", {
      detail: named ?? X402_HEADERS.paymentSignature,
    });
  }
  const method = request.method ?? "GET";
  const upper = method.toUpperCase();
  if (!TOKEN.test(method) || FORBIDDEN_METHODS.includes(upper)) {
    throw new EscroPayError(
      "request",
      `request.method is not a method fetch sends: ${JSON.stringify(method)}`,
      {
        detail: method,
      },
    );
  }
  if ((upper === "GET" || upper === "HEAD") && request.body !== undefined) {
    throw new EscroPayError("request", `A ${upper} request cannot carry a body`, {
      detail: method,
    });
  }
  return {
    offer,
    parts: { method, headers: validated, body: request.body },
  };
}

/**
 * An object whose prototype is Object.prototype or null, not an array, with no own symbol key: the record
 * PayRequest.headers declares. A Headers, an array, a Map or an iterable reads empty to Object.keys and still
 * carries headers into `new Headers(...)`.
 */
function isPlainRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
}

function isPayableUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * The caller's decoded 402, copied once (so nothing the caller holds is read again) and checked
 * through the header codec; the result is a deep-frozen object of pay()'s own.
 */
function copyOfDecoded(required: PaymentRequired): PaymentRequired {
  let header: string;
  try {
    header = encodePaymentRequired(structuredClone(required));
  } catch (cause) {
    throw new EscroError(
      "The 402 is not plain JSON data and cannot be copied",
      "VALIDATION_ERROR",
      undefined,
      { cause },
    );
  }
  const offer = decodePaymentRequired(header);
  deepFreeze(offer);
  return offer;
}

const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);

/** `run` under one deadline of `timeoutMs`: its signal aborts when the deadline passes. */
async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`The deadline of ${String(timeoutMs)} ms passed`));
  }, timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** One request bounded by `signal`; resolves at the response's headers, its body unread. */
async function send(
  url: string,
  parts: RequestParts,
  extraHeaders: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<{ response: Response } | { timedOut: true } | { failed: unknown }> {
  const headers = new Headers(parts.headers);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  try {
    if (parts.pin !== undefined) {
      const init = { method: parts.method, headers, body: parts.body, signal };
      return { response: await pinnedRequest(url, init, parts.pin) };
    }
    const response = await fetch(url, {
      method: parts.method,
      headers,
      ...(parts.body === undefined ? {} : { body: parts.body }),
      redirect: "manual",
      signal,
    });
    return { response };
  } catch (failed) {
    return signal.aborted ? { timedOut: true } : { failed };
  }
}

/**
 * The resource host's answers the caller's rule admitted, from the call's one resolution, within the first request's
 * deadline (`signal`). Refusals name no host, URL or address.
 */
async function pinResource(
  url: string,
  pinning: Pinning,
  signal: AbortSignal,
): Promise<readonly LookupAddress[]> {
  let answers: readonly LookupAddress[];
  try {
    answers = await untilAborted(pinning.resolve(new URL(url).hostname), signal);
  } catch (cause) {
    if (signal.aborted) {
      throw new EscroPayError(
        "timeout",
        `The resource's host did not resolve within ${String(FIRST_REQUEST_TIMEOUT_MS)} ms`,
      );
    }
    throw new EscroPayError("host", "The resource's host did not resolve", {
      detail: "unresolved",
      cause,
    });
  }
  const judged = judge(answers, (address) => pinning.rule(address, "resource"));
  if ("refused" in judged) {
    throw judged.refused === "address"
      ? new EscroPayError(
          "host",
          "The resource's host answered an address the address rule refuses",
          { detail: "address" },
        )
      : new EscroPayError("host", "The resource's host did not resolve", { detail: "unresolved" });
  }
  return judged.admitted;
}

/** url mode: the unpaid request within the first request's deadline (`signal`); its 402 must name `url`. */
async function requestOffer(
  url: string,
  parts: RequestParts,
  signal: AbortSignal,
): Promise<PaymentRequired> {
  const sent = await send(url, parts, {}, signal);
  if ("timedOut" in sent) {
    throw new EscroPayError(
      "timeout",
      `${url} did not answer within ${String(FIRST_REQUEST_TIMEOUT_MS)} ms`,
    );
  }
  if ("failed" in sent) {
    throw new EscroError(`The request to ${url} failed`, "NETWORK_ERROR", undefined, {
      cause: sent.failed,
    });
  }
  const { response } = sent;
  await response.body?.cancel();
  if (isRedirect(response)) {
    throw new EscroPayError("redirect", `${url} answered a redirect; pay() follows none`, {
      detail: String(response.status),
    });
  }
  if (response.status !== 402) {
    throw new EscroPayError("not_402", `${url} answered HTTP ${String(response.status)}, not 402`, {
      detail: String(response.status),
    });
  }
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  if (header === null) {
    throw new X402CodecError(`The 402 from ${url} has no ${X402_HEADERS.paymentRequired} header`);
  }
  const offer = decodePaymentRequired(header);
  deepFreeze(offer);
  if (offer.resource.url !== url) {
    throw new EscroPayError("resource_mismatch", `The 402 from ${url} names another resource`, {
      detail: offer.resource.url,
    });
  }
  return offer;
}

const overCeiling = (entry: PaymentRequirements): boolean =>
  typeof entry.maxTimeoutSeconds === "number" && entry.maxTimeoutSeconds > PAY_MAX_TIMEOUT_SECONDS;

const ceilingRefusal = (entry: PaymentRequirements): EscroPayError =>
  new EscroPayError(
    "timeout_ceiling",
    `The entry's maxTimeoutSeconds ${String(entry.maxTimeoutSeconds)} is over ${String(PAY_MAX_TIMEOUT_SECONDS)}`,
    { detail: String(entry.maxTimeoutSeconds) },
  );

const uptoRefusal = (): EscroPayError =>
  new EscroPayError("unsupported_scheme", "The upto scheme is not paid", { detail: "upto" });

/**
 * The entry to pay, chosen before any RPC read. An entry is eligible when it pays exactly the
 * caller's amount to the caller's `to` on the client's network, its scheme routes to an enabled
 * rail and is one Escro pays (`upto` is not), and its `maxTimeoutSeconds` is within the ceiling.
 * Without a policy the escrow rail wins whatever the 402's order, so the counterparty's list order
 * cannot move the buyer's funds off it; the order decides only within a rail, and a term-matching
 * escrow entry over the ceiling keeps the payment on that rail. A policy's choice must be one of
 * the copied entries and match the terms, and is then routed and held to the ceiling, with no
 * fallback.
 */
function choose(
  offer: PaymentRequired,
  params: PayParams,
  deps: PayOver402Deps,
): PaymentRequirements {
  const network = getCaip2Network(deps.cluster);
  const amount = String(params.amountMicroUsdc);
  const matchesTerms = (entry: PaymentRequirements): boolean =>
    entry.network === network && entry.payTo === params.to && entry.amount === amount;
  const route = (entry: PaymentRequirements): void => {
    const tx: TxShape = {
      to: params.to,
      amountMicroUsdc: params.amountMicroUsdc,
      mode: railOfScheme(entry.scheme) === "x402" ? "sync" : "async",
      accept: entry,
    };
    deps.router.selectRail(tx);
  };

  if (params.policy !== undefined) {
    const view: PayOffer = Object.freeze({
      resource: offer.resource,
      ...(offer.extensions === undefined ? {} : { extensions: offer.extensions }),
    });
    const chosen = params.policy(offer.accepts, view);
    if (!offer.accepts.includes(chosen)) {
      throw new EscroPayError(
        "policy_choice",
        "The policy returned an object that is not one of the entries",
      );
    }
    if (!matchesTerms(chosen)) {
      throw new EscroPayError(
        "no_eligible_entry",
        "The policy chose an entry outside the caller's terms",
      );
    }
    route(chosen);
    if (chosen.scheme === "upto") throw uptoRefusal();
    if (overCeiling(chosen)) throw ceilingRefusal(chosen);
    return chosen;
  }

  const matching = offer.accepts.filter(matchesTerms);
  const enabled = matching.filter((entry) => {
    const rail = railOfScheme(entry.scheme);
    return rail !== undefined && ENABLED_RAILS.includes(rail) && entry.scheme !== "upto";
  });
  const escrowEntries = enabled.filter((entry) => railOfScheme(entry.scheme) === "escrow");
  const candidates = escrowEntries.length > 0 ? escrowEntries : enabled;
  const chosen = candidates.find((entry) => !overCeiling(entry));
  if (chosen !== undefined) {
    route(chosen);
    return chosen;
  }
  for (const entry of matching) {
    const rail = railOfScheme(entry.scheme);
    if (rail !== undefined && !ENABLED_RAILS.includes(rail))
      throw new EscroRailNotEnabledError(rail);
  }
  const first = candidates[0];
  if (first !== undefined) throw ceilingRefusal(first);
  if (matching.length > 0 && matching.every((entry) => entry.scheme === "upto")) {
    throw uptoRefusal();
  }
  throw new EscroPayError(
    "no_eligible_entry",
    `The 402 offers no entry paying ${amount} micro-USDC to ${params.to} on ${network}`,
  );
}

/** The paid request, once, and its settlement; every failure carries `handle`. */
async function present(
  url: string,
  parts: RequestParts,
  header: string,
  timeoutMs: number,
  handle: Handle | X402Handle,
): Promise<{ settlement: SettlementResponse; response: Response }> {
  const sent = await withDeadline(timeoutMs, (signal) =>
    send(url, parts, { [X402_HEADERS.paymentSignature]: header }, signal),
  );
  if ("timedOut" in sent) {
    throw new EscroPayError(
      "timeout",
      `The paid request to ${url} did not answer within ${String(timeoutMs)} ms`,
      handle,
    );
  }
  if ("failed" in sent) {
    throw new EscroPayError("presentation", `The paid request to ${url} failed`, {
      ...handle,
      cause: sent.failed,
    });
  }
  const { response } = sent;
  const answered = { ...handle, status: response.status };
  if (isRedirect(response)) {
    await response.body?.cancel();
    throw new EscroPayError(
      "redirect",
      `The paid request to ${url} answered a redirect; pay() follows none`,
      answered,
    );
  }
  if (!response.ok) {
    const reported = refusalSettlement(response.headers.get(X402_HEADERS.paymentResponse));
    await response.body?.cancel();
    throw new EscroPayError(
      "presentation",
      `The paid request to ${url} answered HTTP ${String(response.status)}`,
      reported === undefined ? answered : { ...answered, settlement: reported },
    );
  }
  const value = response.headers.get(X402_HEADERS.paymentResponse);
  if (value === null) {
    await response.body?.cancel();
    throw new EscroPayError(
      "settlement",
      `The paid answer carries no ${X402_HEADERS.paymentResponse}`,
      answered,
    );
  }
  let settlement: SettlementResponse;
  try {
    settlement = decodePaymentResponse(value);
  } catch (cause) {
    await response.body?.cancel();
    throw new EscroPayError(
      "settlement",
      `The paid answer's ${X402_HEADERS.paymentResponse} does not decode`,
      {
        ...answered,
        cause,
      },
    );
  }
  if (!settlement.success) {
    await response.body?.cancel();
    throw new EscroPayError("settlement", `The worker reported the settlement failed`, {
      ...answered,
      ...(settlement.errorReason === undefined ? {} : { detail: settlement.errorReason }),
    });
  }
  return { settlement, response };
}

/**
 * The settlement a worker sent beside an error status, when its header decodes with a string `transaction` and
 * `network`; otherwise none. It never changes the refusal: an undecodable header on an error answer is not the error.
 */
function refusalSettlement(value: string | null): SettlementResponse | undefined {
  if (value === null) return undefined;
  let settlement: SettlementResponse;
  try {
    settlement = decodePaymentResponse(value);
  } catch {
    return undefined;
  }
  const { transaction, network }: { transaction: unknown; network: unknown } = settlement;
  return typeof transaction === "string" && typeof network === "string" ? settlement : undefined;
}

/**
 * The x402 rail, in order: the requirement checks, the cap admission, the package load and the
 * guarded signature, then one paid request. The amount is credited back only while no signature
 * can exist; once the signer's flag is set it stays counted.
 */
async function payExact(
  deps: PayOver402Deps,
  offer: PaymentRequired,
  chosen: PaymentRequirements,
  parts: RequestParts,
  amountMicroUsdc: number,
): Promise<PaymentResult> {
  checkExactRequirements(chosen, deps.wallet.publicKey, deps.cluster);
  // Echoed into the payment, a non-object `extensions` would make it invalid V2 once signed.
  const extensions: unknown = offer.extensions;
  if (extensions !== undefined && !isRecord(extensions)) {
    throw new EscroPayError("requirements", "The 402's extensions is not a JSON object", {
      detail: "extensions",
    });
  }
  const release = await admitX402Payment(
    deps.x402SpendCap,
    deps.cluster,
    deps.wallet.publicKey.toBase58(),
    amountMicroUsdc,
  );
  const signed: { memo?: string } = {};
  let payload: { transaction: string };
  try {
    payload = await exactPayload(chosen, {
      wallet: deps.wallet,
      cluster: deps.cluster,
      rpcUrl: deps.rpcUrl,
      onSigned: (memo) => {
        signed.memo = memo;
      },
    });
  } catch (err) {
    if (signed.memo === undefined) release();
    throw err;
  }
  if (signed.memo === undefined) {
    release();
    throw new EscroPayError("transaction", "The x402 scheme client returned an unsigned payment", {
      detail: "build",
    });
  }

  const handle: X402Handle = {
    payment: { memo: signed.memo, amountMicroUsdc, payTo: chosen.payTo },
  };
  const url = offer.resource.url;
  let paid: { settlement: SettlementResponse; response: Response };
  try {
    paid = await present(
      url,
      parts,
      encodePaymentSignature({
        x402Version: 2,
        resource: offer.resource,
        accepted: chosen,
        payload: { ...payload },
        ...(extensions === undefined ? {} : { extensions }),
      }),
      chosen.maxTimeoutSeconds * 1000,
      handle,
    );
  } catch (err) {
    if (err instanceof EscroPayError) throw err;
    throw new EscroPayError("presentation", "Presenting the x402 payment failed", {
      ...handle,
      cause: err,
    });
  }
  // The header decoder checks only `success`; this rail's reference is the settlement's transaction.
  const transaction: unknown = paid.settlement.transaction;
  if (typeof transaction !== "string" || transaction === "") {
    await paid.response.body?.cancel();
    throw new EscroPayError("settlement", "The paid answer names no settlement transaction", {
      ...handle,
      status: paid.response.status,
    });
  }
  return { rail: "x402", reference: transaction, ...paid };
}

/**
 * Pays a 402 for {@link Escro.pay}: checks the arguments, takes the offer (requesting `params.url`,
 * or copying `params.paymentRequired`) and chooses an entry matching the caller's `to`, amount and
 * cluster. An x402-routed entry goes to {@link payExact}; an escrow entry is funded through
 * {@link parseEscrowAccept} and {@link fundSelection} (so through `createEscrow` and its spend
 * cap). The payment is presented once to the 402's resource URL. With `admitAddress`, every request of the call
 * connects only to the answers the rule admitted from one resolution of its host; in url mode the resource host's
 * lookup and the unpaid request share the first request's one deadline.
 */
export async function payOver402(deps: PayOver402Deps, params: PayParams): Promise<PaymentResult> {
  const { offer: given, parts: unpinned } = checkArguments(params);
  const rule = params.admitAddress;
  const pinning: Pinning | undefined =
    rule === undefined ? undefined : { rule, resolve: callResolver() };
  const pinnedTo = async (url: string, signal: AbortSignal): Promise<RequestParts> =>
    pinning === undefined
      ? unpinned
      : { ...unpinned, pin: await pinResource(url, pinning, signal) };
  let parts = unpinned;
  let offer: PaymentRequired;
  if ("decoded" in given) {
    offer = copyOfDecoded(given.decoded);
  } else {
    const { url } = given;
    [parts, offer] = await withDeadline(FIRST_REQUEST_TIMEOUT_MS, async (signal) => {
      const pinned = await pinnedTo(url, signal);
      return [pinned, await requestOffer(url, pinned, signal)] as const;
    });
  }
  const resourceUrl = offer.resource.url;
  // A decoded 402 names its own URL; one fetch would refuse must not reach the create.
  if (!isPayableUrl(resourceUrl)) {
    throw new EscroPayError(
      "url",
      "The 402's resource.url must be an absolute http: or https: URL without credentials",
      { detail: "resource.url" },
    );
  }
  if (isBadPortUrl(new URL(resourceUrl))) {
    throw new EscroPayError("url", "The 402's resource.url names a port fetch blocks", {
      detail: "resource.url",
    });
  }
  // Before any policy call, chain read, spec fetch or signature.
  if ("decoded" in given) {
    parts = await withDeadline(FIRST_REQUEST_TIMEOUT_MS, (signal) => pinnedTo(resourceUrl, signal));
  }
  const chosen = choose(offer, params, deps);
  if (railOfScheme(chosen.scheme) === "x402") {
    return payExact(deps, offer, chosen, parts, params.amountMicroUsdc);
  }

  const platformConfig = await readPlatformConfig(deps.rpc, deps.cluster);
  const amount = BigInt(params.amountMicroUsdc);
  const selection = parseEscrowAccept(
    { ...offer, accepts: [chosen] },
    {
      cluster: deps.cluster,
      platformConfig,
      maxDepositMicroUsdc: amount + escrowFee(amount, platformConfig.feeBps),
      payTo: params.to,
      ...(params.admitAcceptance === undefined ? {} : { admitAcceptance: params.admitAcceptance }),
    },
  );
  const { payment } = await fundSelection(
    selection,
    {
      escro: deps.escro,
      wallet: deps.wallet,
      resourceUrl,
      // judge() admits an answer only when the rule returns exactly true.
      ...(pinning === undefined
        ? {}
        : { admitAddress: (address: string) => pinning.rule(address, "spec") }),
    },
    pinning?.resolve ?? callResolver(),
  );

  const handle: Handle = {
    escrowPda: payment.payload.escrow,
    createSignature: payment.payload.createSignature,
  };
  let paid: { settlement: SettlementResponse; response: Response };
  try {
    paid = await present(
      resourceUrl,
      parts,
      // The spread only types the payload fields as the codec's Record; the payment is not written.
      encodePaymentSignature({ ...payment, payload: { ...payment.payload } }),
      selection.entry.maxTimeoutSeconds * 1000,
      handle,
    );
  } catch (err) {
    if (err instanceof EscroPayError) throw err;
    throw new EscroPayError(
      "presentation",
      "Presenting the payment failed after the escrow was funded",
      {
        ...handle,
        cause: err,
      },
    );
  }
  return {
    rail: "escrow",
    reference: handle.createSignature,
    escrow: handle.escrowPda,
    ...paid,
  };
}
