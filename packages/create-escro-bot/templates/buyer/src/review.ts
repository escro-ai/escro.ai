// review.ts: YOU ARE THE JUDGE.
//
// Escro only enforces the state machine; whether a deliverable is acceptable is
// entirely your bot's decision (this is the whole product: the buyer's code is
// the judge, the contract never scores quality). This file is the ONLY place
// quality judgment belongs. Four review patterns ship as code below. The
// default, `review`, is `hash-matches` over `review.expectedSha256` in
// escro.config.ts: it fetches the delivery itself and releases only bytes that
// hash to the SHA-256 you set, with that decision as the release's memo. With no
// expected hash it releases nothing. Replace its body with another pattern (or
// your own) to judge differently.

import { createHash } from "node:crypto";
import { lookup as systemLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { isBadPortUrl, paramsHash, payAddressRule, predicateJob, runPredicate } from "@escro/sdk";
import type { ZkmlDeliverable, ZkmlReviewPolicy, ZkmlReviewResult } from "@escro/sdk";
import type { Acceptance, HostLookup, PredicateResult } from "@escro/sdk";

/** The submitted deliverable, read off the escrow's on-chain/read-model fields. */
export type Deliverable = ZkmlDeliverable;
/** A release decision: release, or hold, or contest via dispute (see `review` below). */
export type ReviewResult = ZkmlReviewResult;
/** A named review predicate; `evaluate` may answer synchronously or asynchronously. */
export type ReviewPolicy = ZkmlReviewPolicy;

/** A decision that, on accept, may carry the predicate record the release's memo is computed from. */
export type PredicateReviewResult = ReviewResult & { predicate?: PredicateResult };

/** The escrow under review: its address, and when its deliverable was submitted (unix seconds). */
export interface ReviewedEscrow {
  address: string;
  submittedAt: number | null;
}

/** A review the settle pass runs; every `ReviewPolicy` above is one. */
export interface KitReviewPolicy {
  name: string;
  evaluate(
    d: Deliverable,
    escrow: ReviewedEscrow,
  ): PredicateReviewResult | Promise<PredicateReviewResult>;
}

/** The program's auto-release window after a submission (`timeout_release`), in seconds. */
export const REVIEW_WINDOW_SECONDS = 86_400;
/** A delivery still unfetchable this long before the window closes is disputed, not left to the timeout. */
export const FETCH_DISPUTE_MARGIN_SECONDS = 3_600;

/**
 * Pattern 1: checksum / format (deterministic). For a canned or deterministic
 * job you already KNOW the correct output's hash; release only when the submitted
 * hash equals that independently-expected value. Integrity comes from YOUR
 * expectation, never from trusting the submitted hash as self-certifying.
 */
export function checksumReview(expectedContentHash: string): ReviewPolicy {
  return {
    name: "checksum",
    evaluate(d: Deliverable): ReviewResult {
      return d.contentHash === expectedContentHash
        ? {
            accept: true,
            dispute: false,
            reason: `contentHash matches expected ${expectedContentHash}.`,
          }
        : {
            accept: false,
            dispute: true,
            reason: `contentHash ${JSON.stringify(d.contentHash)} != expected ${expectedContentHash}.`,
          };
    },
  };
}

/**
 * Pattern 2: eval threshold. Fetch the deliverable, RE-VERIFY it hashes to the
 * submitted contentHash (reject a tampered/wrong artifact before scoring), score
 * it, and release only when score >= threshold. `fetchContent`, `evaluate` and
 * `hash` are yours (e.g. `hash` = sha256 hex).
 */
export function evalThresholdReview(opts: {
  threshold: number;
  fetchContent: (proofUri: string) => Promise<string>;
  evaluate: (content: string) => number | Promise<number>;
  hash: (content: string) => string;
}): ReviewPolicy {
  return {
    name: "eval-threshold",
    async evaluate(d: Deliverable): Promise<ReviewResult> {
      if (d.proofUri === null) {
        return {
          accept: false,
          dispute: true,
          reason: "no proofUri to fetch the deliverable from.",
        };
      }
      const content = await opts.fetchContent(d.proofUri);
      if (opts.hash(content) !== d.contentHash) {
        return {
          accept: false,
          dispute: true,
          reason:
            "fetched deliverable does not hash to the submitted contentHash (tampered or wrong).",
        };
      }
      const score = await opts.evaluate(content);
      return score >= opts.threshold
        ? {
            accept: true,
            dispute: false,
            reason: `eval ${String(score)} >= threshold ${String(opts.threshold)}.`,
          }
        : {
            accept: false,
            dispute: true,
            reason: `eval ${String(score)} < threshold ${String(opts.threshold)}.`,
          };
    },
  };
}

/**
 * Pattern 3: human in the loop. Print where the deliverable is and wait for a
 * person to decide (a CLI confirm). `confirm` returns true to release, false to
 * dispute.
 */
export function humanInLoopReview(opts: {
  confirm: (deliverable: Deliverable) => Promise<boolean> | boolean;
  print?: (message: string) => void;
}): ReviewPolicy {
  const print =
    opts.print ??
    ((m: string): void => {
      console.log(m);
    });
  return {
    name: "human-in-the-loop",
    async evaluate(d: Deliverable): Promise<ReviewResult> {
      print(
        `Review deliverable: hash=${JSON.stringify(d.contentHash)} ` +
          `proof=${d.proofUri === null ? "(none)" : JSON.stringify(d.proofUri)}`,
      );
      const ok = await opts.confirm(d);
      return ok
        ? { accept: true, dispute: false, reason: "approved by human review." }
        : { accept: false, dispute: true, reason: "rejected by human review." };
    },
  };
}

export interface DeliveryFetchOptions {
  cluster: "devnet" | "mainnet";
  /** Admits private and loopback addresses (and, off devnet, http:). */
  allowPrivateHosts: boolean;
  maxBytes: number;
  /** One bound over the lookup, the connection and the whole body. Default 30 000. */
  timeoutMs?: number;
  /** Resolves the host, once. Default: node:dns/promises lookup. */
  lookup?: HostLookup;
  /** A test seam: replaces the lookup and the pinned connection. The bot never passes it. */
  fetch?: typeof fetch;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A URL's hostname as an address rule sees it: an IPv6 literal without its brackets. */
function unbracketed(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** `promise`, or a rejection once `signal` aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error("the fetch was aborted");
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(reason());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

interface Judged {
  address: string;
  family: 4 | 6;
}

/**
 * The host's addresses from exactly one lookup (a literal is its own answer), each put to the
 * SDK's address rule. One refused answer, or none, refuses the host: any answer could be the one
 * connected to.
 */
async function judgedAddresses(
  url: URL,
  opts: DeliveryFetchOptions,
  signal: AbortSignal,
): Promise<Judged[]> {
  const host = unbracketed(url.hostname);
  let answers: readonly { address: string }[];
  if (isIP(host) !== 0) {
    answers = [{ address: host }];
  } else {
    const lookup: HostLookup = opts.lookup ?? ((name, options) => systemLookup(name, options));
    try {
      answers = await untilAborted(lookup(host, { all: true }), signal);
    } catch (err) {
      throw new Error(`the lookup of ${host} failed: ${messageOf(err)}`);
    }
  }
  if (answers.length === 0) throw new Error(`${host} resolved to no address`);
  const rule = payAddressRule({
    cluster: opts.cluster,
    allowPrivateHosts: opts.allowPrivateHosts,
    url: url.href,
  });
  const refused = answers.filter(
    ({ address }) => isIP(address) === 0 || (rule !== undefined && !rule(address, "resource")),
  );
  if (refused.length > 0) {
    throw new Error(
      `${host} resolves to ${refused.map((a) => a.address).join(", ")}, which this buyer does not ` +
        "connect to (review.allowPrivateHosts admits a private host)",
    );
  }
  return answers.map(({ address }) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
}

type SocketLookup = NonNullable<http.RequestOptions["lookup"]>;

/** Answers the socket's lookup from the judged list, in the form it is asked; it never resolves. */
function pinnedLookup(pinned: readonly Judged[]): SocketLookup {
  return (_hostname, options, callback) => {
    const { family } = options;
    const wanted =
      family === 4 || family === "IPv4" ? 4 : family === 6 || family === "IPv6" ? 6 : 0;
    const answers = wanted === 0 ? [...pinned] : pinned.filter((a) => a.family === wanted);
    const first = answers.at(0);
    if (first === undefined) {
      callback(
        Object.assign(new Error("no judged address of the family asked"), { code: "ENOTFOUND" }),
        "",
      );
      return;
    }
    if (options.all === true) callback(null, answers);
    else callback(null, first.address, first.family);
  };
}

const isSuccess = (status: number): boolean => status >= 200 && status <= 299;

/**
 * One GET of `url` connecting only to `pinned`, following no redirect, counting the body as it
 * arrives: past `maxBytes` the connection is destroyed. The bytes are returned only once the
 * connection has closed after a complete body, so bytes sent past a declared Content-Length (a
 * parse error) fail the fetch instead of being cut off unseen.
 */
function pinnedGet(
  url: URL,
  pinned: readonly Judged[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const secure = url.protocol === "https:";
    const name = unbracketed(url.hostname);
    const options: https.RequestOptions = {
      method: "GET",
      headers: { accept: "*/*" },
      // A fresh agent: no pooled socket, none reused.
      agent: false,
      lookup: pinnedLookup(pinned),
      // The certificate is checked against the URL's name; an IP literal sends no SNI.
      ...(secure && { servername: isIP(name) === 0 ? name : "" }),
    };
    const request = secure ? https.request(url, options) : http.request(url, options);
    const chunks: Buffer[] = [];
    let received = 0;
    let bodyEnded = false;
    let settled = false;
    const onAbort = (): void => {
      fail(messageOf(signal.reason));
    };
    function fail(message: string): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      request.destroy();
      reject(new Error(`the fetch of ${url.href} failed: ${message}`));
    }
    request.on("response", (response: http.IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (!isSuccess(status)) {
        fail(`it answered ${String(status)}`);
        return;
      }
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          fail(`the body is over ${String(maxBytes)} bytes`);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        bodyEnded = true;
      });
      response.on("error", (err: Error) => {
        fail(err.message);
      });
    });
    request.on("error", (err: Error) => {
      fail(err.message);
    });
    request.on("close", () => {
      if (settled) return;
      if (!bodyEnded) {
        fail("the connection closed before the body ended");
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

/** The injected `fetch` in place of the lookup and the pinned connection; the status and the byte count still apply. */
async function seamGet(
  fetchImpl: typeof fetch,
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await untilAborted(fetchImpl(url.href, { redirect: "manual", signal }), signal);
  if (!isSuccess(response.status)) {
    await response.body?.cancel();
    throw new Error(`the fetch of ${url.href} failed: it answered ${String(response.status)}`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await untilAborted(reader.read(), signal);
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(
        `the fetch of ${url.href} failed: the body is over ${String(maxBytes)} bytes`,
      );
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The URL a delivery may be fetched from, or a thrown Error before any lookup or request. */
function deliveryUrl(proofUri: string, opts: DeliveryFetchOptions): URL {
  if (!URL.canParse(proofUri)) {
    throw new Error(`the delivery URI ${JSON.stringify(proofUri)} is not a URL`);
  }
  const url = new URL(proofUri);
  // The worker chooses the URI, so a credential in it would go to whatever host it names. Checked
  // first, and the message names the host only, so the credential reaches no log.
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      `the delivery URI for ${url.host} carries a username or password, which this buyer never sends`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `the delivery URI ${JSON.stringify(proofUri)} is not http: or https:, which this buyer fetches`,
    );
  }
  if (opts.cluster === "mainnet" && url.protocol === "http:" && !opts.allowPrivateHosts) {
    throw new Error(
      `the delivery URI ${JSON.stringify(proofUri)} is http: on mainnet; only https: is fetched`,
    );
  }
  if (isBadPortUrl(url)) {
    throw new Error(
      `the delivery URI ${JSON.stringify(proofUri)} names port ${url.port}, which fetch blocks and this buyer never connects to`,
    );
  }
  return url;
}

/** The bytes at `proofUri`, or a thrown Error naming why not. */
export async function fetchDelivery(
  proofUri: string,
  opts: DeliveryFetchOptions,
): Promise<Uint8Array> {
  const url = deliveryUrl(proofUri, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`no complete answer within ${String(timeoutMs)} ms`));
  }, timeoutMs);
  try {
    if (opts.fetch !== undefined) {
      return await seamGet(opts.fetch, url, opts.maxBytes, controller.signal);
    }
    const pinned = await judgedAddresses(url, opts, controller.signal);
    return await pinnedGet(url, pinned, opts.maxBytes, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface HashMatchesReviewOptions extends DeliveryFetchOptions {
  /** The SHA-256 (64 lowercase hex) of the exact bytes this buyer expects; undefined holds every delivery. */
  sha256: string | undefined;
  /** Unix seconds. Default: the system clock. */
  now?: () => number;
}

const hold = (reason: string): PredicateReviewResult => ({
  accept: false,
  dispute: false,
  reason,
});
const disputeWith = (reason: string): PredicateReviewResult => ({
  accept: false,
  dispute: true,
  reason,
});

/**
 * Pattern 4: hash-matches. Release only bytes this buyer fetched itself that hash both to the
 * SHA-256 you expect and to the worker's on-chain commitment; the release carries the decision
 * memo. A commitment to another hash, or bytes hashing to something else, is disputed. A delivery
 * it cannot fetch is held and retried each pass until an hour before the 24h timeout, then
 * disputed, so the timeout never pays for a delivery this buyer could not check.
 */
export function hashMatchesReview(opts: HashMatchesReviewOptions): KitReviewPolicy {
  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  return {
    name: "hash-matches",
    async evaluate(d: Deliverable, escrow: ReviewedEscrow): Promise<PredicateReviewResult> {
      const expected = opts.sha256;
      if (expected === undefined) {
        return hold(
          `No expected hash is set (review.expectedSha256), so ${JSON.stringify(d.contentHash)} is not released; ` +
            "the 24h timeout pays the worker unless you set one or dispute.",
        );
      }
      if (d.contentHash !== expected) {
        return disputeWith(
          `The worker committed ${JSON.stringify(d.contentHash)}, not the expected ${expected}.`,
        );
      }
      let bytes: Uint8Array;
      try {
        if (d.proofUri === null) throw new Error("the delivery carries no proofUri");
        bytes = await fetchDelivery(d.proofUri, opts);
      } catch (err) {
        const why = messageOf(err);
        if (escrow.submittedAt === null) {
          return disputeWith(
            `Could not fetch the delivery (${why}) and its submission time is unknown.`,
          );
        }
        const disputeAt = escrow.submittedAt + REVIEW_WINDOW_SECONDS - FETCH_DISPUTE_MARGIN_SECONDS;
        if (now() >= disputeAt) {
          return disputeWith(`Could not fetch the delivery before the 24h timeout: ${why}`);
        }
        return hold(
          `Could not fetch the delivery yet (${why}); retried each pass, disputed from ` +
            `${String(disputeAt)} (${new Date(disputeAt * 1000).toISOString()}) if still unfetched.`,
        );
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== d.contentHash) {
        return disputeWith(
          `The delivered bytes hash to ${actual}, not the committed ${d.contentHash}.`,
        );
      }
      const params = { sha256: expected };
      const acceptance: Acceptance = { name: "hash-matches", paramsHash: paramsHash(params) };
      const predicate = await runPredicate(
        { acceptance, params, job: predicateJob(opts.cluster, escrow.address) },
        { bytes },
      );
      if (predicate.record.decision !== "pass") return disputeWith(predicate.reason);
      return { accept: true, dispute: false, reason: `${predicate.reason}.`, predicate };
    },
  };
}

export interface ReviewSettings {
  cluster: "devnet" | "mainnet";
  expectedSha256?: string | undefined;
  allowPrivateHosts: boolean;
  maxDeliveryBytes: number;
}

/**
 * The default review: hash-matches over the settings bot.ts reads from escro.config.ts's `review`
 * block. Replace its body with a pattern above (or your own) to judge differently.
 */
export function review(settings: ReviewSettings): KitReviewPolicy {
  return hashMatchesReview({
    sha256: settings.expectedSha256,
    cluster: settings.cluster,
    allowPrivateHosts: settings.allowPrivateHosts,
    maxBytes: settings.maxDeliveryBytes,
  });
}
