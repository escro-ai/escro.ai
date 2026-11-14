// pay()'s transport when its caller gives an address rule (PayParams.admitAddress). Each host is resolved once per
// call, every answer is put to the rule, and the request goes over node:http or node:https with a `lookup` that answers
// only the admitted addresses from memory, so the address judged is the address connected to. global fetch takes no
// lookup, which is why this is not fetch. TLS keeps Node's default checks against the URL's name: nothing here takes a
// CA, a verification switch or an agent from a caller.
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** A frozen view whose set lives in this closure, so the table is not module-level state any importer could change. */
function readonlySetOf(values: readonly number[]): ReadonlySet<number> {
  const set = new Set(values);
  const view: ReadonlySet<number> = Object.freeze({
    get size(): number {
      return set.size;
    },
    has: (value: number): boolean => set.has(value),
    forEach: (
      callback: (value: number, key: number, of: ReadonlySet<number>) => void,
      thisArg?: unknown,
    ): void => {
      set.forEach((value) => {
        callback.call(thisArg, value, value, view);
      });
    },
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    [Symbol.iterator]: () => set.values(),
  });
  return view;
}

/**
 * The Fetch standard's bad ports (§ "should be blocked due to a bad port", whatwg/fetch `fetch.bs` at
 * e9460d1b22ead1c6a72eeac37fb2ec0dc01aeb1d): `fetch` refuses them and the pinned transport would not, so pay() and the
 * job-specification read refuse them before either. Port 0 is the standard's, though Node's `fetch` lacks it.
 */
export const FETCH_BAD_PORTS: ReadonlySet<number> = readonlySetOf([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** An http: or https: URL whose port (the scheme's default when the URL names none) `fetch` blocks. */
export function isBadPortUrl(url: URL): boolean {
  const defaultPort = url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : undefined;
  if (defaultPort === undefined) return false;
  return FETCH_BAD_PORTS.has(url.port === "" ? defaultPort : Number(url.port));
}

/** One call's resolutions: a host is looked up at most once, and every request of the call reads that answer. */
export type HostResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

/** A URL's hostname as the rule sees it: an IPv6 literal without its brackets. */
function unbracketed(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** A literal is its own answer (Node calls no lookup for one, so it is judged here); a name is looked up. */
async function resolveHost(hostname: string): Promise<readonly LookupAddress[]> {
  const host = unbracketed(hostname);
  const family = isIP(host);
  if (family !== 0) return [{ address: host, family }];
  return lookup(host, { all: true });
}

export function callResolver(): HostResolver {
  const answers = new Map<string, Promise<readonly LookupAddress[]>>();
  return (hostname) => {
    const known = answers.get(hostname);
    if (known !== undefined) return known;
    const answer = resolveHost(hostname);
    // A caller past its deadline stops listening; the lookup's later rejection must not go unhandled.
    answer.catch(() => undefined);
    answers.set(hostname, answer);
    return answer;
  };
}

/** `promise`, or the abort reason once `signal` aborts first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error("The request was aborted");
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

export type Judgement =
  | { admitted: readonly LookupAddress[] }
  | { refused: "address" | "unresolved" };

/**
 * Every answer put to `admit`: an address is admitted only when `admit` returns exactly true, a rule that throws
 * refuses, and one refused answer refuses the host, since any answer could be connected to. No answer is unresolved.
 */
export function judge(
  answers: readonly LookupAddress[],
  admit: (address: string) => unknown,
): Judgement {
  if (answers.length === 0) return { refused: "unresolved" };
  const admits = (address: string): boolean => {
    try {
      return admit(address) === true;
    } catch {
      return false;
    }
  };
  return answers.every(({ address }) => admits(address))
    ? { admitted: answers }
    : { refused: "address" };
}

type LookupFunction = NonNullable<http.RequestOptions["lookup"]>;

/** Answers Node's socket lookup from the judged list, in the form it is asked; it never resolves. */
function pinnedLookup(pinned: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const { family } = options;
    const wanted =
      family === 4 || family === "IPv4" ? 4 : family === 6 || family === "IPv6" ? 6 : 0;
    const answers =
      wanted === 0 ? [...pinned] : pinned.filter((answer) => answer.family === wanted);
    const [first] = answers;
    if (first === undefined) {
      callback(
        Object.assign(new Error("No admitted address of the family asked"), { code: "ENOTFOUND" }),
        "",
      );
      return;
    }
    if (options.all === true) callback(null, answers);
    else callback(null, first.address, first.family);
  };
}

const NULL_BODY_STATUSES: readonly number[] = [204, 205, 304];

export interface PinnedInit {
  method: string;
  headers: Headers;
  body?: string | undefined;
  /** Bounds the connect and the headers, and once the response is out, its body. */
  signal: AbortSignal;
}

/** The response at its headers, body unread; cancelling the body destroys the socket. `url` is the requested URL. */
function responseOf(message: http.IncomingMessage, url: string, method: string): Response {
  const headers = new Headers();
  const raw = message.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const status = message.statusCode ?? 0;
  const nullBody = method === "HEAD" || NULL_BODY_STATUSES.includes(status);
  if (nullBody) {
    // Nothing reads a null body, so a socket reset after the headers must not surface as an uncaught error.
    message.on("error", () => undefined);
    message.resume();
  }
  const body = nullBody ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>);
  const response = new Response(body, { status, statusText: message.statusMessage ?? "", headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/**
 * One request to `url` connecting only to `pinned`, framed as fetch frames it (`accept: *\/*` and `user-agent: node`
 * where the caller set none, a string body's length and default content type) with no encoding of its own, following
 * no redirect. The method is sent upper-cased whatever its case: node:http upper-cases every method, where fetch
 * keeps a method other than DELETE, GET, HEAD, OPTIONS, POST and PUT as given. Rejects with Node's own error (a TLS failure's code intact), or a status a
 * Response cannot hold.
 */
export function pinnedRequest(
  url: string,
  init: PinnedInit,
  pinned: readonly LookupAddress[],
): Promise<Response> {
  const target = new URL(url);
  const method = init.method.toUpperCase();
  const headers: Record<string, string> = {};
  init.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (!init.headers.has("accept")) headers.accept = "*/*";
  if (!init.headers.has("user-agent")) headers["user-agent"] = "node";
  let payload: Buffer | undefined;
  if (init.body !== undefined) {
    payload = Buffer.from(init.body, "utf8");
    if (!init.headers.has("content-type")) headers["content-type"] = "text/plain;charset=UTF-8";
    headers["content-length"] = String(payload.byteLength);
  } else if (method === "POST" || method === "PUT") {
    headers["content-length"] = "0";
  }
  const secure = target.protocol === "https:";
  const name = unbracketed(target.hostname);
  const options: https.RequestOptions = {
    method,
    headers,
    // A fresh agent per request: no socket from a global pool, none reused by another call.
    agent: false,
    lookup: pinnedLookup(pinned),
    signal: init.signal,
    // The certificate is checked against the URL's name, never the pinned address. An IP literal sends no SNI, and an
    // empty servername keeps a caller's Host header from naming the certificate in its place.
    ...(secure ? { servername: isIP(name) === 0 ? name : "" } : {}),
  };
  return new Promise<Response>((resolve, reject) => {
    const onResponse = (message: http.IncomingMessage): void => {
      try {
        resolve(responseOf(message, url, method));
      } catch (err) {
        message.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const request = secure
      ? https.request(target, options, onResponse)
      : http.request(target, options, onResponse);
    request.on("error", reject);
    request.end(payload);
  });
}
