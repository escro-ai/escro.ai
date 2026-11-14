// The worker's 402 menu (docs/specs/scheme_on_delivery_svm.md "Server, per paid request"): a paid request is verified
// against an entry this server rebuilds itself, the claim lands with the operator's client, the job is polled by the
// buyer alone.
import {
  ChainReadError,
  EscroConfirmError,
  EscroError,
  EscrowStateError,
  OnDeliveryAcceptError,
  UnauthorizedError,
  X402CodecError,
  X402_HEADERS,
  buildEscrowAccept,
  computeTaskSpecHash,
  decodePaymentSignature,
  encodePaymentRequired,
  encodePaymentResponse,
  memoryReplayStore,
  readPlatformConfig,
  verifyBuyerPresentation,
  verifyEscrowPayload,
  type BazaarDeclaration,
  type OnDeliveryAccept,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ReplayStore,
  type ResourceInfo,
  type SettlementResponse,
  type TaskSpec,
} from "@escro/sdk";

import { claimSettlement, escrowAccept } from "./accept.js";
import { readBody } from "./body.js";
import { ExactLeg, type ExactOutcome, type ExactServed } from "./exact.js";
import { memoryJobStore } from "./job-store.js";
import { SpecStore } from "./spec-store.js";
import { ClaimRefusedError } from "./errors.js";
import type {
  ClaimHookJob,
  ClaimedJob,
  JobRecord,
  JobStore,
  MenuRequest,
  SignatureStatusRpc,
  X402Menu,
  X402MenuOptions,
  X402Route,
} from "./index.js";

const ON_DELIVERY = "on-delivery";
const NO_PAYMENT = "PAYMENT-SIGNATURE header is required";
const DEADLINE = "invalid_on_delivery_svm_deadline";
const CLAIM_FAILED = "invalid_on_delivery_svm_claim_failed";
const BAD_PAYLOAD = "invalid_on_delivery_svm_payload";
const PATH_MISMATCH = "invalid_on_delivery_svm_escrow_address_mismatch";
const BUYER_MISMATCH = "invalid_on_delivery_svm_buyer_mismatch";
const SPEC_FILE = /^[0-9a-f]{64}\.json$/;
const PLACEHOLDER_SPEC_HASH = "0".repeat(64);

const DEFAULT_SPEC_PATH = "/specs";
const DEFAULT_POLL_PATH = "/v1/jobs";
const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_DEADLINE_SECONDS = 2_592_000;
const DEFAULT_MAX_SPECS = 1_024;
const DEFAULT_FEE_CACHE_MS = 60_000;
const DEFAULT_FACILITATOR_CACHE_MS = 300_000;
const MIN_EXACT_TIMEOUT_SECONDS = 10;
/** An hour: the paid answer's deadline is a `setTimeout`, which overflows above about 2 147 483 s. */
const MAX_EXACT_TIMEOUT_SECONDS = 3_600;
const U64_MAX = 2n ** 64n - 1n;
const DEFAULT_MAX_BODY_BYTES = 65_536;
// The discovery caps: what the catalogs keep (x402 specs/extensions/bazaar.md "Service Metadata on resource"; CDP
// refuses a verify or settle whose description exceeds 500 characters), and what keeps every x402 line of a route
// carrying all of them under a default proxy's 8 190-byte line limit (the README's "Header sizes behind a proxy").
const MAX_BAZAAR_BYTES = 1_024;
const MAX_DESCRIPTION_BYTES = 500;
const MAX_ICON_URL_BYTES = 512;
const MAX_SERVICE_NAME = 32;
const MAX_TAGS = 5;
const MAX_TAG = 32;
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const LOOPBACK_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);
// getSignatureStatuses refuses more signatures than this in one call.
const STATUS_BATCH = 256;

/**
 * How long a claim signature whose status reads null may still land, in ms: a blockhash's lifetime (roughly 60 to 90 s
 * on mainnet) plus the API's one-minute ingest sweep, with margin. A signature still unseen this long after it was sent
 * can no longer land.
 */
export const CLAIM_HOLD_MS = 300_000;

type StatusEntry = Awaited<ReturnType<SignatureStatusRpc["getSignatureStatuses"]>>["value"][number];

/**
 * A signature's status: `unseen` is a null entry; `unresolved` is processed, unconfirmed or unread, with or without an
 * error. An error read at processed level is not final: a fork can drop it and the same signature still land.
 */
type SignatureOutcome = "landed" | "failed" | "unseen" | "unresolved";

function outcomeOf(status: StatusEntry | undefined): SignatureOutcome {
  if (status === undefined) return "unresolved";
  if (status === null) return "unseen";
  const level = status.confirmationStatus;
  if (level !== "confirmed" && level !== "finalized") return "unresolved";
  return status.err === null ? "landed" : "failed";
}

/**
 * The claim transaction's own signature a rejection carries (the SDK attaches it to every error raised from the send
 * on); none for a TX_FAILED, a claim that executed and failed.
 */
function sentSignature(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  if (err instanceof EscroError && err.code === "TX_FAILED") return undefined;
  const own: unknown = Object.getOwnPropertyDescriptor(err, "signature")?.value;
  return typeof own === "string" ? own : undefined;
}

/** A record no landed path may overwrite or hand off again: its claim is already known, or the job moved on. */
const isSettled = (record: JobRecord): boolean =>
  record.status !== "claimed" || record.claimSignature !== undefined;

/** The 402 resource's service metadata as served: `iconUrl` in its parsed form. */
interface ServedService {
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** A route with its defaults applied. */
interface ServedRoute {
  config: X402Route;
  key: string;
  url: string;
  service: ServedService;
  /** A copy of the route's declaration, taken when the menu is built. */
  bazaar: BazaarDeclaration | undefined;
  maxTimeoutSeconds: number;
  maxDeadlineSeconds: number;
  exact: ExactServed | undefined;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

/** A presentation the verifier found valid, with what the claim needs. */
interface PaidJob {
  served: ServedRoute;
  spec: TaskSpec;
  entry: OnDeliveryAccept;
  request: MenuRequest;
  feeBps: number;
  escrow: string;
  buyer: string;
  deadline: number;
}

type Presented =
  | { kind: "unpaid" }
  | { kind: "paid"; payment: PaymentPayload }
  | { kind: "exact"; payment: PaymentPayload }
  | { kind: "refused"; error: string }
  | { kind: "pass" };

const json = (status: number, value: unknown, headers: Record<string, string> = {}): Answer => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(value),
});

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

function requireOrigin(publicUrl: string): void {
  let url: URL | undefined;
  try {
    url = new URL(publicUrl);
  } catch {
    url = undefined;
  }
  // The origin of a URL with a path, query, fragment or userinfo differs from the URL's own text.
  if (url?.protocol !== "https:" || url.origin !== publicUrl) {
    throw new Error(
      `publicUrl must be an https: origin (scheme, host, optional port) with no path, query, fragment or userinfo: ${publicUrl}`,
    );
  }
}

/**
 * A path as the loosest router behind the menu routes it: decoded, cut at a ";" (a query delimiter in Fastify's router by
 * default), duplicate slashes collapsed, one trailing slash removed. Undefined when it does not decode.
 */
function canonicalPath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURI(pathname);
  } catch {
    return undefined;
  }
  const path = (decoded.split(";", 1)[0] ?? "").replace(/\/{2,}/g, "/");
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// ASCII only, so a folded path keeps the length of its canonical form and a base58 tail can be cut from the original.
// The spec and poll tails use it; the route lookup lowercases in full.
const foldCase = (path: string): string => path.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The folded canonical form of a configured path; undefined when it cannot match a request. */
function matchKey(path: string): string | undefined {
  if (path.includes(";")) return undefined;
  const canonical = canonicalPath(path);
  // Tested decoded, so a percent-encoded form is caught: a case-insensitive router folds what foldCase leaves alone.
  if (canonical === undefined || /[\u0080-\uffff]/.test(canonical)) return undefined;
  return foldCase(canonical);
}

function requirePath(name: string, path: string): string {
  const key = matchKey(path);
  if (
    key === undefined ||
    path.length < 2 ||
    !path.startsWith("/") ||
    path.endsWith("/") ||
    /[?#]/.test(path)
  ) {
    throw new Error(
      `${name} must start with "/", decode, hold no code point above 0x7F, and carry no trailing "/", ";", query or fragment: ${path}`,
    );
  }
  return key;
}

/** The route with its defaults; throws on one that would advertise an entry the chain or a buyer refuses. */
function serveRoute(
  route: X402Route,
  options: X402MenuOptions,
  service: ServedService,
  specUrl: (specHash: string) => string,
): ServedRoute {
  const key = `${route.method} ${route.path}`;
  const refuse = (what: string): never => {
    throw new Error(`Route ${key}: ${what}`);
  };
  if (!/^\/[^?#]*$/.test(route.path) || matchKey(route.path) === undefined) {
    refuse(
      'path must start with "/", decode, hold no code point above 0x7F, and carry no query or ";"',
    );
  }
  if (!isPositiveInteger(route.workSeconds)) refuse("workSeconds must be a positive integer");
  const maxTimeoutSeconds = route.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!isPositiveInteger(maxTimeoutSeconds)) {
    refuse("maxTimeoutSeconds must be a positive integer");
  }
  const maxDeadlineSeconds = route.maxDeadlineSeconds ?? DEFAULT_MAX_DEADLINE_SECONDS;
  if (!isPositiveInteger(maxDeadlineSeconds) || maxDeadlineSeconds < route.workSeconds) {
    refuse("maxDeadlineSeconds must be a positive integer no smaller than workSeconds");
  }
  try {
    buildEscrowAccept({
      cluster: options.cluster,
      amountMicroUsdc: route.priceMicroUsdc,
      payTo: options.payTo,
      specHash: PLACEHOLDER_SPEC_HASH,
      specUri: specUrl(PLACEHOLDER_SPEC_HASH),
      deadline: 0,
      feeBps: 0,
      maxTimeoutSeconds,
    });
  } catch (err) {
    if (!(err instanceof OnDeliveryAcceptError)) throw err;
    const reason = err.refusals[0]?.reason;
    if (reason === "pay_to") throw new Error(`payTo is not a canonical key: ${options.payTo}`);
    refuse(`priceMicroUsdc or the terms are refused (${String(reason)})`);
  }
  if (route.description !== undefined) {
    const fault = descriptionFault(route.description);
    if (fault !== undefined) refuse(`description ${fault}`);
  }
  let bazaar: BazaarDeclaration | undefined;
  if (route.bazaar !== undefined) {
    const fault = bazaarFault(route.bazaar, route.method);
    if (fault !== undefined) refuse(`bazaar ${fault}`);
    bazaar = copyJson(route.bazaar);
  }
  return {
    config: route,
    key,
    url: `${options.publicUrl}${route.path}`,
    service,
    bazaar,
    maxTimeoutSeconds,
    maxDeadlineSeconds,
    exact: exactRoute(route, options, refuse),
  };
}

const utf8 = new TextEncoder();

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Where `value` would not come back deep-equal from a JSON round trip; undefined when it would. */
function jsonFault(value: unknown, at: string): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? undefined
      : `${at} is ${String(value)}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) return `${at}[${String(i)}] is a hole`;
      const fault = jsonFault(value[i], `${at}[${String(i)}]`);
      if (fault !== undefined) return fault;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) return `${at} has a symbol key`;
    for (const [key, member] of Object.entries(value)) {
      const fault = jsonFault(member, `${at}.${key}`);
      if (fault !== undefined) return fault;
    }
    return undefined;
  }
  return `${at} is not JSON (${typeof value})`;
}

/** A lone surrogate, or a code point in U+0000 to U+001F or U+007F to U+009F. */
function textFault(text: string): string | undefined {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return "holds a lone surrogate";
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return "holds a lone surrogate";
    } else if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) {
      return `holds the control character U+${unit.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return undefined;
}

function descriptionFault(description: string): string | undefined {
  if (description === "") return "must not be empty";
  const fault = textFault(description);
  if (fault !== undefined) return fault;
  if (utf8.encode(description).length > MAX_DESCRIPTION_BYTES) {
    return `must be at most ${String(MAX_DESCRIPTION_BYTES)} UTF-8 bytes`;
  }
  return undefined;
}

/** A `$ref` or `$id` string anywhere in `value` that is not a same-document `#` fragment. */
function externalReference(value: unknown, at: string): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = externalReference(value[i], `${at}[${String(i)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [key, member] of Object.entries(value)) {
    if (
      (key === "$ref" || key === "$id") &&
      typeof member === "string" &&
      !member.startsWith("#")
    ) {
      return `${at}.${key}`;
    }
    const found = externalReference(member, `${at}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Why a catalog would refuse the declaration or a header could not carry it (x402 specs/extensions/bazaar.md "Schema
 * Validation": a facilitator resolves no external reference); undefined when it is served.
 */
function bazaarFault(bazaar: unknown, method: X402Route["method"]): string | undefined {
  if (!isPlainObject(bazaar)) return "must be an object";
  const fault = jsonFault(bazaar, "bazaar");
  if (fault !== undefined) return `must survive a JSON round trip: ${fault}`;
  if (utf8.encode(JSON.stringify(bazaar)).length > MAX_BAZAAR_BYTES) {
    return `must be at most ${String(MAX_BAZAAR_BYTES)} UTF-8 bytes of JSON`;
  }
  const { info, schema } = bazaar;
  const input = isPlainObject(info) ? info.input : undefined;
  if (!isPlainObject(input)) return "info.input must be an object";
  if (input.type !== "http") return 'info.input.type must be "http"';
  if (input.method !== method) return `info.input.method must be the route's method, ${method}`;
  if (!isPlainObject(schema)) return "schema must be an object";
  if (schema.$schema !== DRAFT_2020_12) return `schema.$schema must be ${DRAFT_2020_12}`;
  const external = externalReference(schema, "schema");
  if (external !== undefined) return `${external} must be a same-document "#" reference`;
  return undefined;
}

const isPrintableAscii = (text: string): boolean => /^[ -~]*$/.test(text);

/** The menu's service metadata as every 402 serves it; throws naming `service.<field>`. */
function serveService(service: X402MenuOptions["service"]): ServedService {
  if (service === undefined) return {};
  const refuse = (field: string, what: string): never => {
    throw new Error(`service.${field} ${what}`);
  };
  const { serviceName, tags, iconUrl } = service;
  if (
    serviceName !== undefined &&
    (serviceName === "" || serviceName.length > MAX_SERVICE_NAME || !isPrintableAscii(serviceName))
  ) {
    refuse(
      "serviceName",
      `must be 1 to ${String(MAX_SERVICE_NAME)} printable ASCII characters (U+0020 to U+007E)`,
    );
  }
  if (tags !== undefined) {
    if (tags.length > MAX_TAGS) refuse("tags", `must list at most ${String(MAX_TAGS)} tags`);
    const seen = new Set<string>();
    for (const tag of tags) {
      if (tag === "" || tag.length > MAX_TAG || !isPrintableAscii(tag)) {
        refuse(
          "tags",
          `entries must be 1 to ${String(MAX_TAG)} printable ASCII characters (U+0020 to U+007E)`,
        );
      }
      const folded = tag.toLowerCase();
      if (seen.has(folded)) refuse("tags", `lists ${JSON.stringify(tag)} twice, ignoring case`);
      seen.add(folded);
    }
  }
  const servedIcon = iconUrl === undefined ? undefined : serveIconUrl(iconUrl, refuse);
  return {
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(tags === undefined ? {} : { tags: [...tags] }),
    ...(servedIcon === undefined ? {} : { iconUrl: servedIcon }),
  };
}

/**
 * The icon's served form, `new URL(iconUrl).href`: an https: URL on a named host (never an IP literal or a loopback
 * name), no userinfo, not SVG by its path (CDP lists JPG, PNG, WebP and GIF icons).
 */
function serveIconUrl(iconUrl: string, refuse: (field: string, what: string) => never): string {
  const fault = (what: string): never => refuse("iconUrl", `${what}: ${JSON.stringify(iconUrl)}`);
  // The URL parser drops a tab or a newline silently; the configured text must not hold one.
  if (textFault(iconUrl) !== undefined) fault("must hold no control character or lone surrogate");
  let url: URL;
  try {
    url = new URL(iconUrl);
  } catch {
    return fault("must be an absolute URL");
  }
  if (url.protocol !== "https:") fault("must be an https: URL");
  if (url.username !== "" || url.password !== "") fault("must carry no username or password");
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  // The parser rewrites a numeric, hex or percent-encoded IPv4 host to its dotted form.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) {
    fault("must name a host, not an IP address");
  }
  if (LOOPBACK_NAMES.has(host)) fault("must not name a loopback host");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return fault("must have a path that percent-decodes");
  }
  if (path.endsWith(".svg") || path.endsWith(".svgz")) fault("must not be an SVG image");
  const served = url.href;
  if (utf8.encode(JSON.stringify(served)).length - 2 > MAX_ICON_URL_BYTES) {
    fault(`must be at most ${String(MAX_ICON_URL_BYTES)} bytes once JSON-encoded`);
  }
  return served;
}

/** The route's `exact` leg with its defaults; throws on one that cannot settle, or cannot answer in time. */
function exactRoute(
  route: X402Route,
  options: X402MenuOptions,
  refuse: (what: string) => never,
): ExactServed | undefined {
  const leg = route.settleExact;
  if (leg === undefined) return undefined;
  if (options.facilitator === undefined) {
    refuse("settleExact needs options.facilitator to settle through");
  }
  if (route.exact !== undefined) refuse("settleExact and exact cannot both be set");
  if (leg.priceMicroUsdc < 1n || leg.priceMicroUsdc > U64_MAX) {
    refuse("settleExact.priceMicroUsdc must be between 1 and 2^64 - 1");
  }
  const maxTimeoutSeconds = leg.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < MIN_EXACT_TIMEOUT_SECONDS ||
    maxTimeoutSeconds > MAX_EXACT_TIMEOUT_SECONDS
  ) {
    refuse(
      `settleExact.maxTimeoutSeconds must be a whole number from ${String(MIN_EXACT_TIMEOUT_SECONDS)} to ${String(MAX_EXACT_TIMEOUT_SECONDS)}`,
    );
  }
  return { config: leg, maxTimeoutSeconds };
}

/** The account's deadline; the verifier has refused an escrow whose deadline is not a number. */
function deadlineOf(escrow: Record<string, unknown>): number {
  const { deadline } = escrow;
  if (typeof deadline !== "number") throw new Error("A verified escrow carries no deadline");
  return deadline;
}

function escrowOf(payment: PaymentPayload): string {
  const { escrow } = payment.payload;
  if (typeof escrow !== "string") throw new Error("A verified payload carries no escrow address");
  return escrow;
}

class Menu implements X402Menu {
  readonly paths: X402Menu["paths"];
  private readonly specKey: string;
  private readonly pollKey: string;
  private readonly routes = new Map<string, ServedRoute>();
  private readonly pollEntry: OnDeliveryAccept;
  private readonly specs: SpecStore;
  private readonly replay: ReplayStore;
  private readonly jobs: JobStore;
  private readonly now: () => number;
  private readonly claim: (job: ClaimHookJob) => Promise<string>;
  private readonly feeCacheMs: number;
  private readonly maxBodyBytes: number;
  private readonly flights = new Map<string, Promise<Answer>>();
  private readonly exactLeg: ExactLeg | undefined;
  /**
   * Per escrow, the signatures of this menu's own claims that threw with their outcome unknown, each with the time it
   * was added. In memory only: after a restart a landed one is resumed by the operator's own loop, if any.
   */
  private readonly pending = new Map<string, Map<string, number>>();
  private feeCache: { bps: number; at: number } | undefined;
  private feeRead: Promise<number | undefined> | undefined;
  private unauthorizedLogged = false;

  constructor(private readonly options: X402MenuOptions) {
    requireOrigin(options.publicUrl);
    const spec = options.specPath ?? DEFAULT_SPEC_PATH;
    const poll = options.pollPath ?? DEFAULT_POLL_PATH;
    this.specKey = requirePath("specPath", spec);
    this.pollKey = requirePath("pollPath", poll);
    this.paths = { spec, poll };
    const service = serveService(options.service);
    for (const route of options.routes) {
      const served = serveRoute(route, options, service, (hash) => this.specUrl(hash));
      const key = `${route.method} ${matchKey(route.path) ?? route.path}`;
      if (this.routes.has(key)) {
        throw new Error(`Route ${served.key}: two routes share this method and path`);
      }
      this.routes.set(key, served);
    }
    const [first] = this.routes.values();
    if (first === undefined) throw new Error("routes must hold at least one route");
    if (
      options.facilitatorCacheMs !== undefined &&
      !isPositiveInteger(options.facilitatorCacheMs)
    ) {
      throw new Error("facilitatorCacheMs must be a positive integer");
    }
    this.pollEntry = this.verificationEntry(first, PLACEHOLDER_SPEC_HASH, 0);
    this.specs = new SpecStore(options.maxSpecs ?? DEFAULT_MAX_SPECS);
    this.replay = options.replay ?? memoryReplayStore();
    this.jobs = options.jobs ?? memoryJobStore();
    this.now = options.now ?? Date.now;
    this.claim = options.claim ?? ((job) => options.escro.claimTask(job.escrow));
    this.feeCacheMs = options.feeCacheMs ?? DEFAULT_FEE_CACHE_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.exactLeg =
      options.facilitator === undefined
        ? undefined
        : new ExactLeg({
            facilitator: options.facilitator,
            cluster: options.cluster,
            payTo: options.payTo,
            replay: this.replay,
            now: this.now,
            cacheMs: options.facilitatorCacheMs ?? DEFAULT_FACILITATOR_CACHE_MS,
            holdMs: CLAIM_HOLD_MS,
          });
  }

  async fetch(request: Request): Promise<Response | undefined> {
    const answer = await this.answer(request);
    if (answer === undefined) return undefined;
    // A copy: Response takes only a byte array over a plain ArrayBuffer.
    const body = typeof answer.body === "string" ? answer.body : new Uint8Array(answer.body);
    return new Response(body, { status: answer.status, headers: answer.headers });
  }

  async submit(
    escrow: string,
    result: { contentHash: string; proofUri?: string },
  ): Promise<string> {
    let submitSignature: string;
    try {
      submitSignature = await this.options.escro.submitDeliverable(escrow, result);
    } catch (err) {
      // Thrown only after the transaction confirmed: the API failed to record it, and a retried submit cannot land.
      if (!(err instanceof EscroConfirmError)) throw err;
      submitSignature = err.signature;
    }
    // A record with no route or buyer stands for a job resumed after a restart, before its buyer has presented again.
    const record = (await this.jobs.get(escrow)) ?? { escrow, route: "" };
    await this.jobs.put({
      ...record,
      status: "submitted",
      submitSignature,
      contentHash: result.contentHash,
      ...(result.proofUri === undefined ? {} : { proofUri: result.proofUri }),
    });
    return submitSignature;
  }

  private specUrl(specHash: string): string {
    return `${this.options.publicUrl}${this.paths.spec}/${specHash}.json`;
  }

  private pollUrl(escrow: string): string {
    return `${this.options.publicUrl}${this.paths.poll}/${escrow}`;
  }

  /** The entry the verifier checks against: its deadline floor of 0 never binds, the menu applies the bounds itself. */
  private verificationEntry(
    served: ServedRoute,
    specHash: string,
    feeBps: number,
  ): OnDeliveryAccept {
    return buildEscrowAccept({
      cluster: this.options.cluster,
      amountMicroUsdc: served.config.priceMicroUsdc,
      payTo: this.options.payTo,
      specHash,
      specUri: this.specUrl(specHash),
      deadline: 0,
      feeBps,
      maxTimeoutSeconds: served.maxTimeoutSeconds,
    });
  }

  private async answer(request: Request): Promise<Answer | undefined> {
    const url = new URL(request.url);
    const canonical = canonicalPath(url.pathname);
    if (canonical === undefined) return json(400, { error: "invalid_path" });
    // Express and Fastify both run a GET route's handler for HEAD.
    const method = request.method === "HEAD" ? "GET" : request.method;
    // Lowercased in full, as find-my-way does under caseSensitive: false: U+212A (Kelvin sign) reaches a route's "k".
    // Every route key is ASCII (matchKey), so its ASCII fold is its full lowercase.
    const served = this.routes.get(`${method} ${canonical.toLowerCase()}`);
    if (served !== undefined) return this.answerRoute(served, request, url);
    if (request.method !== "GET") return undefined;
    const folded = foldCase(canonical);
    const spec = this.tail(folded, this.specKey);
    if (spec !== undefined && SPEC_FILE.test(spec)) return this.answerSpec(spec);
    const escrow = this.tail(folded, this.pollKey);
    return escrow === undefined
      ? undefined
      : this.answerPoll(request, canonical.slice(canonical.length - escrow.length));
  }

  /** The one path segment after `prefix`; undefined when `path` is anything else. */
  private tail(path: string, prefix: string): string | undefined {
    if (!path.startsWith(`${prefix}/`)) return undefined;
    const rest = path.slice(prefix.length + 1);
    return rest === "" || rest.includes("/") ? undefined : rest;
  }

  private answerSpec(file: string): Answer {
    const text = this.specs.get(file.slice(0, -".json".length), this.now());
    if (text === undefined) return json(404, { error: "spec_not_found" });
    return { status: 200, headers: { "content-type": "application/json" }, body: text };
  }

  private async answerPoll(request: Request, escrow: string): Promise<Answer> {
    const header = request.headers.get(X402_HEADERS.paymentSignature);
    if (header === null) return json(403, { error: BAD_PAYLOAD });
    let payment: PaymentPayload;
    try {
      payment = decodePaymentSignature(header);
    } catch (err) {
      if (!(err instanceof X402CodecError)) throw err;
      return json(403, { error: BAD_PAYLOAD });
    }
    if (payment.payload.escrow !== escrow) return json(403, { error: PATH_MISMATCH });
    // Before the store: an anonymous poll costs no job-store read, and learns nothing of which jobs exist.
    const verdict = await verifyBuyerPresentation(payment, this.pollEntry, {
      resourceUrl: this.pollUrl(escrow),
      replay: this.replay,
      now: this.now,
    });
    if (!verdict.isValid) return json(403, { error: verdict.invalidReason });
    const record = await this.jobs.get(escrow);
    if (record === undefined) return json(404, { error: "job_not_found" });
    if (record.buyer === undefined || record.buyer !== verdict.payer) {
      return json(403, { error: BUYER_MISMATCH });
    }
    const { status, claimSignature, submitSignature, contentHash, proofUri } = record;
    return json(200, { escrow, status, claimSignature, submitSignature, contentHash, proofUri });
  }

  /** Routes on the decoded scheme only: it selects a handler, never the terms. */
  private presented(served: ServedRoute, request: Request, url: URL): Presented {
    const header = request.headers.get(X402_HEADERS.paymentSignature);
    // A HEAD never settles or reaches the handler, whatever it presents.
    if (header === null || request.method === "HEAD") return { kind: "unpaid" };
    const bodiless: MenuRequest = {
      method: served.config.method,
      path: served.config.path,
      query: url.searchParams,
      body: undefined,
    };
    let payment: PaymentPayload;
    try {
      payment = decodePaymentSignature(header);
    } catch (err) {
      if (!(err instanceof X402CodecError)) throw err;
      const elsewhere = offeredEntries(served.config, bodiless).some(
        (e) => e.scheme !== ON_DELIVERY,
      );
      return elsewhere ? { kind: "pass" } : { kind: "refused", error: "invalid_payload" };
    }
    const { scheme } = payment.accepted;
    if (scheme === ON_DELIVERY) return { kind: "paid", payment };
    if (scheme === "exact" && served.exact !== undefined) return { kind: "exact", payment };
    return offeredEntries(served.config, bodiless).some((e) => e.scheme === scheme)
      ? { kind: "pass" }
      : { kind: "refused", error: "invalid_scheme" };
  }

  private async answerRoute(
    served: ServedRoute,
    request: Request,
    url: URL,
  ): Promise<Answer | undefined> {
    const presented = this.presented(served, request, url);
    if (presented.kind === "pass") return undefined;
    const arrival = this.now();
    const body = await readBody(request, this.maxBodyBytes);
    if (body.kind === "too_large") return json(413, { error: "body_too_large" });
    if (body.kind === "unreadable") return json(400, { error: "invalid_body" });
    const menuRequest: MenuRequest = {
      method: served.config.method,
      path: served.config.path,
      query: url.searchParams,
      body: body.value,
    };
    const spec = await served.config.taskSpec(menuRequest);
    if (presented.kind === "exact") {
      return this.answerExact(served, presented.payment, spec, menuRequest, arrival);
    }
    if (presented.kind === "paid") {
      const feeBps = await this.feeBps();
      if (feeBps === undefined) return json(503, { error: "chain_unavailable" });
      return this.answerPaid(served, presented.payment, spec, menuRequest, feeBps);
    }
    // The fee and the `exact` fee payer are read side by side; neither waits on the other.
    const [feeBps, exact] = await Promise.all([this.feeBps(), this.offeredExact(served)]);
    if (feeBps === undefined) return json(503, { error: "chain_unavailable" });
    const error = presented.kind === "refused" ? presented.error : NO_PAYMENT;
    return this.offer(served, spec, menuRequest, feeBps, error, exact);
  }

  /** The route's `exact` entry for an unpaid request's 402; undefined when the route has none or none is known. */
  private offeredExact(served: ServedRoute): Promise<PaymentRequirements | undefined> {
    if (served.exact === undefined || this.exactLeg === undefined)
      return Promise.resolve(undefined);
    return this.exactLeg.offered(served.exact);
  }

  /** A paid `exact` request: settled by the leg, or refused with a fresh 402 built here. */
  private async answerExact(
    served: ServedRoute,
    payment: PaymentPayload,
    spec: TaskSpec,
    request: MenuRequest,
    arrival: number,
  ): Promise<Answer> {
    const { exact } = served;
    if (exact === undefined || this.exactLeg === undefined) {
      throw new Error(`Route ${served.key}: an exact payment reached a route with no exact leg`);
    }
    const outcome: ExactOutcome = await this.exactLeg.settle({
      served: exact,
      payment,
      spec,
      request,
      resource: resourceOf(served),
      ...(served.bazaar === undefined ? {} : { bazaar: copyJson(served.bazaar) }),
      arrival,
    });
    if (outcome.kind === "answer") return outcome;
    const feeBps = await this.feeBps();
    if (feeBps === undefined) return json(503, { error: "chain_unavailable" });
    const entry = outcome.exact ? this.exactLeg.known(exact) : undefined;
    const fresh = this.offer(served, spec, request, feeBps, outcome.error, entry);
    return { ...fresh, headers: { ...fresh.headers, ...outcome.headers } };
  }

  /** PlatformConfig's fee, read once at a time and cached for feeCacheMs; undefined when the read failed. */
  private async feeBps(): Promise<number | undefined> {
    const at = this.now();
    if (this.feeCache !== undefined && at < this.feeCache.at + this.feeCacheMs) {
      return this.feeCache.bps;
    }
    this.feeRead ??= this.readFee(at).finally(() => {
      this.feeRead = undefined;
    });
    return this.feeRead;
  }

  private async readFee(at: number): Promise<number | undefined> {
    try {
      const { feeBps } = await readPlatformConfig(this.options.rpc, this.options.cluster);
      this.feeCache = { bps: feeBps, at };
      return feeBps;
    } catch {
      // Never a default or a stale fee: the caller answers 503 and the buyer retries.
      return undefined;
    }
  }

  private offer(
    served: ServedRoute,
    spec: TaskSpec,
    request: MenuRequest,
    feeBps: number,
    error: string,
    exact?: PaymentRequirements,
  ): Answer {
    const { config, maxTimeoutSeconds } = served;
    const nowMs = this.now();
    const built = escrowAccept({
      cluster: this.options.cluster,
      payTo: this.options.payTo,
      priceMicroUsdc: config.priceMicroUsdc,
      taskSpec: spec,
      specUri: this.specUrl(computeTaskSpecHash(spec)),
      feeBps,
      deadline: Math.floor(nowMs / 1_000) + maxTimeoutSeconds + config.workSeconds,
      maxTimeoutSeconds,
      ...(config.extension === undefined ? {} : { extension: config.extension }),
    });
    this.specs.put(built.specHash, spec, nowMs + maxTimeoutSeconds * 1_000);
    const extensions: Record<string, unknown> = {
      ...(built.extension === undefined ? {} : { escro: built.extension }),
      ...(served.bazaar === undefined ? {} : { bazaar: served.bazaar }),
    };
    const required: PaymentRequired = {
      x402Version: 2,
      error,
      resource: resourceOf(served),
      accepts: [
        built.accept,
        ...(exact === undefined ? [] : [exact]),
        ...offeredEntries(config, request),
      ],
      ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
    };
    return json(402, required, {
      [X402_HEADERS.paymentRequired]: encodePaymentRequired(required),
    });
  }

  private async answerPaid(
    served: ServedRoute,
    payment: PaymentPayload,
    spec: TaskSpec,
    request: MenuRequest,
    feeBps: number,
  ): Promise<Answer> {
    const entry = this.verificationEntry(served, computeTaskSpecHash(spec), feeBps);
    let verdict;
    try {
      verdict = await verifyEscrowPayload(payment, entry, {
        rpc: this.options.rpc,
        replay: this.replay,
        resourceUrl: served.url,
        now: this.now,
      });
    } catch (err) {
      if (err instanceof ChainReadError) return json(503, { error: "chain_unavailable" });
      throw err;
    }
    if (!verdict.isValid) return this.offer(served, spec, request, feeBps, verdict.invalidReason);
    const job: PaidJob = {
      served,
      spec,
      entry,
      request,
      feeBps,
      escrow: escrowOf(payment),
      buyer: verdict.payer,
      deadline: deadlineOf(verdict.escrow),
    };
    // No await before the map is written: of the presentations in flight, one claims (or reads the escrow's pending
    // signatures) and the rest wait for its answer.
    const flight = this.flights.get(job.escrow);
    if (flight !== undefined) return flight;
    const retry = verdict.job === "retry";
    if (retry && !this.pending.has(job.escrow)) {
      return this.answerRetry(job, await this.jobs.get(job.escrow));
    }
    const answering = (retry ? this.answerPendingRetry(job) : this.answerNewJob(job)).finally(
      () => {
        this.flights.delete(job.escrow);
      },
    );
    this.flights.set(job.escrow, answering);
    return answering;
  }

  /** A retry of an escrow with pending signatures: a landed one is handed off, else the retry answers as ever. */
  private async answerPendingRetry(job: PaidJob): Promise<Answer> {
    const { landed } = await this.readSignatures(job.escrow, undefined);
    if (landed !== undefined) return this.claimLanded(job, landed);
    return this.answerRetry(job, await this.jobs.get(job.escrow));
  }

  private async answerNewJob(job: PaidJob): Promise<Answer> {
    // A claim of this menu's that landed after it threw: claiming again would fail against it.
    const { landed } = await this.readSignatures(job.escrow, undefined);
    if (landed !== undefined) return this.claimLanded(job, landed);
    // A record exists only after a landed claim: an RPC lagging this worker's own claim still reads Funded.
    const record = await this.jobs.get(job.escrow);
    if (record !== undefined) return this.answerRetry(job, record);
    const nowSeconds = Math.floor(this.now() / 1_000);
    const { config, maxDeadlineSeconds } = job.served;
    if (
      job.deadline < nowSeconds + config.workSeconds ||
      job.deadline > nowSeconds + maxDeadlineSeconds
    ) {
      return this.offer(job.served, job.spec, job.request, job.feeBps, DEADLINE);
    }
    return this.claimJob(job);
  }

  private async claimJob(job: PaidJob): Promise<Answer> {
    let claimSignature: string;
    try {
      claimSignature = await this.claim({
        escrow: job.escrow,
        buyer: job.buyer,
        deadline: job.deadline,
        route: job.served.key,
      });
    } catch (err) {
      // Thrown only after the claim confirmed on chain: the API failed to record it. Checked first because its code
      // may be the API's TX_FAILED, which here does not mean the transaction failed.
      if (!(err instanceof EscroConfirmError)) return this.claimRejected(job, err);
      claimSignature = err.signature;
    }
    this.pending.delete(job.escrow);
    return this.recordClaim(job, claimSignature, undefined);
  }

  /**
   * A claim that threw: a landed signature among the escrow's pending ones and the claim's own takes the landed path;
   * the claim's own signature failed on chain answers 409; anything else is classified by the error.
   */
  private async claimRejected(job: PaidJob, err: unknown): Promise<Answer> {
    const sent = sentSignature(err);
    const { landed, sentFailed } = await this.readSignatures(job.escrow, sent);
    if (landed !== undefined) return this.claimLanded(job, landed);
    if (sentFailed) return this.claimFailed(job);
    return this.claimFailure(job, err);
  }

  /**
   * Reads the escrow's pending signatures and `sent`; returns a landed one. Otherwise a failed signature leaves the
   * set, so does one still unseen CLAIM_HOLD_MS after it was added, and `sent`, unresolved, joins it.
   */
  private async readSignatures(
    escrow: string,
    sent: string | undefined,
  ): Promise<{ landed: string | undefined; sentFailed: boolean }> {
    const pending = this.pending.get(escrow) ?? new Map<string, number>();
    const candidates = [...pending.keys()];
    if (sent !== undefined && !pending.has(sent)) candidates.push(sent);
    if (candidates.length === 0) return { landed: undefined, sentFailed: false };
    const outcomes = await this.readStatuses(candidates);
    const landed = candidates.find((signature) => outcomes.get(signature) === "landed");
    if (landed !== undefined) {
      this.pending.delete(escrow);
      return { landed, sentFailed: false };
    }
    const nowMs = this.now();
    for (const signature of candidates) {
      const outcome = outcomes.get(signature);
      const addedAt = pending.get(signature) ?? nowMs;
      if (outcome === "failed" || (outcome === "unseen" && nowMs - addedAt >= CLAIM_HOLD_MS)) {
        pending.delete(signature);
      } else if (signature === sent && !pending.has(signature)) {
        pending.set(signature, nowMs);
      }
    }
    if (pending.size === 0) this.pending.delete(escrow);
    else this.pending.set(escrow, pending);
    return {
      landed: undefined,
      sentFailed: sent !== undefined && outcomes.get(sent) === "failed",
    };
  }

  /** Each signature's outcome, read at most STATUS_BATCH at a time; a batch whose read fails stays unresolved. */
  private async readStatuses(signatures: string[]): Promise<Map<string, SignatureOutcome>> {
    const outcomes = new Map<string, SignatureOutcome>();
    for (let at = 0; at < signatures.length; at += STATUS_BATCH) {
      const batch = signatures.slice(at, at + STATUS_BATCH);
      let value: StatusEntry[];
      try {
        ({ value } = await this.options.rpc.getSignatureStatuses(batch, {
          searchTransactionHistory: true,
        }));
      } catch (err) {
        // Not a verdict: the signatures stay pending and the claim's error is answered as it is.
        console.error(`A claim's signature status read failed: ${messageOf(err)}`);
        continue;
      }
      batch.forEach((signature, i) => outcomes.set(signature, outcomeOf(value[i])));
    }
    return outcomes;
  }

  /**
   * A claim of this menu's that threw and that the status read showed landed: the API is asked to record it, then,
   * unless the job's record already knows its claim or has moved on, recorded and handed off once.
   */
  private async claimLanded(job: PaidJob, claimSignature: string): Promise<Answer> {
    this.pending.delete(job.escrow);
    const before = await this.jobs.get(job.escrow);
    if (before !== undefined && isSettled(before)) return this.answerRetry(job, before);
    try {
      await this.options.escro.confirm(job.escrow, claimSignature);
    } catch (err) {
      // The claim landed whatever the API says: its work starts, and the API's sweep records it.
      console.error(`The API did not record the landed claim of ${job.escrow}: ${messageOf(err)}`);
    }
    // Re-read: a submit or another path may have written the record while the confirm ran.
    const current = await this.jobs.get(job.escrow);
    if (current !== undefined && isSettled(current)) return this.answerRetry(job, current);
    return this.recordClaim(job, claimSignature, current);
  }

  /** Records a landed claim `claimed`, keeping a re-recorded record's other fields, hands it off and answers 202. */
  private async recordClaim(
    job: PaidJob,
    claimSignature: string,
    existing: JobRecord | undefined,
  ): Promise<Answer> {
    const record: JobRecord =
      existing === undefined
        ? {
            escrow: job.escrow,
            buyer: job.buyer,
            route: job.served.key,
            status: "claimed",
            claimSignature,
          }
        : { ...existing, buyer: job.buyer, status: "claimed", claimSignature };
    try {
      await this.jobs.put(record);
    } catch (err) {
      // The claim stands: answering a failure would leave a claimed escrow whose work never starts.
      console.error(`The job store refused a landed claim: ${messageOf(err)}`);
    }
    this.handOff(job, claimSignature);
    return this.accepted(job, claimSignature);
  }

  private claimFailed(job: PaidJob): Answer {
    const failed: SettlementResponse = {
      success: false,
      transaction: "",
      network: job.entry.network,
      payer: job.buyer,
      errorReason: CLAIM_FAILED,
    };
    return json(
      409,
      { error: CLAIM_FAILED },
      { [X402_HEADERS.paymentResponse]: encodePaymentResponse(failed) },
    );
  }

  private claimFailure(job: PaidJob, err: unknown): Answer {
    if (err instanceof ClaimRefusedError) return this.workerUnavailable(job, err.message);
    if (
      err instanceof EscrowStateError ||
      (err instanceof EscroError && err.code === "TX_FAILED")
    ) {
      return this.claimFailed(job);
    }
    if (err instanceof UnauthorizedError) {
      if (!this.unauthorizedLogged) {
        this.unauthorizedLogged = true;
        console.error(err.message);
      }
      return this.workerUnavailable(job, "this worker's wallet cannot claim the job");
    }
    return json(503, { error: "claim_unavailable" });
  }

  private workerUnavailable(job: PaidJob, reason: string): Answer {
    return json(503, {
      error: "worker_unavailable",
      reason,
      nextActions: [
        {
          action: "cancel",
          actor: "buyer",
          channel: "onchain",
          network: job.entry.network,
          instruction: "cancel_escrow",
          address: job.escrow,
        },
      ],
    });
  }

  private async answerRetry(job: PaidJob, existing: JobRecord | undefined): Promise<Answer> {
    if (existing === undefined) {
      const created: JobRecord = {
        escrow: job.escrow,
        buyer: job.buyer,
        route: job.served.key,
        status: "claimed",
      };
      await this.jobs.put(created);
      return this.accepted(job, undefined);
    }
    // Its claim is known or the job moved on: no pending signature of the escrow can be handed off.
    if (isSettled(existing)) this.pending.delete(job.escrow);
    if (existing.buyer === undefined) await this.jobs.put({ ...existing, buyer: job.buyer });
    return this.accepted(job, existing.claimSignature);
  }

  private accepted(job: PaidJob, claimSignature: string | undefined): Answer {
    const poll = this.pollUrl(job.escrow);
    if (claimSignature === undefined) return json(202, { escrow: job.escrow, poll });
    const extension = job.served.config.extension;
    const settlement = claimSettlement({
      entry: job.entry,
      escrow: job.escrow,
      buyer: job.buyer,
      escrowDeadline: job.deadline,
      claimSignature,
      pollUrl: poll,
      ...(extension === undefined ? {} : { extension }),
    });
    return json(
      202,
      { escrow: job.escrow, poll },
      { [X402_HEADERS.paymentResponse]: encodePaymentResponse(settlement) },
    );
  }

  /** Runs onClaimed without holding the 202; a rejection is recorded, never answered. */
  private handOff(job: PaidJob, claimSignature: string): void {
    const claimed: ClaimedJob = {
      escrow: job.escrow,
      buyer: job.buyer,
      taskSpec: job.spec,
      deadline: job.deadline,
      claimSignature,
      route: job.served.key,
    };
    void Promise.resolve()
      .then(() => job.served.config.onClaimed(claimed))
      .catch((err: unknown) => this.recordFailed(job.escrow, err))
      .catch((err: unknown) => {
        console.error(`The job store refused a failed hand-off: ${messageOf(err)}`);
      });
  }

  private async recordFailed(escrow: string, err: unknown): Promise<void> {
    const current = await this.jobs.get(escrow);
    // A submit that landed before the hand-off rejected stands.
    if (current?.status !== "claimed") return;
    await this.jobs.put({ ...current, status: "failed", error: messageOf(err) });
  }
}

/** The route's own 402 resource, from config alone; a fresh object each call. */
function resourceOf(served: ServedRoute): ResourceInfo {
  const { config, service } = served;
  return {
    url: served.url,
    ...(config.description === undefined ? {} : { description: config.description }),
    ...(config.mimeType === undefined ? {} : { mimeType: config.mimeType }),
    ...(service.serviceName === undefined ? {} : { serviceName: service.serviceName }),
    ...(service.tags === undefined ? {} : { tags: [...service.tags] }),
    ...(service.iconUrl === undefined ? {} : { iconUrl: service.iconUrl }),
  };
}

function offeredEntries(route: X402Route, request: MenuRequest): PaymentRequirements[] {
  return typeof route.exact === "function" ? route.exact(request) : (route.exact ?? []);
}

/**
 * A 402 menu over the operator's routes. Throws on a configuration that would advertise an entry the chain or a
 * buyer refuses, naming the route or the field.
 */
export function createX402Menu(options: X402MenuOptions): X402Menu {
  return new Menu(options);
}
