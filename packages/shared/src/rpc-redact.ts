// The one RPC URL redactor. A keyed RPC URL is a secret, never logged, and its key can sit
// in the userinfo, a path segment, a query value or a subdomain. RPC clients quote the request URL
// as written (fetch refuses a URL with userinfo by quoting it) or normalised (a slash before the
// query, a lowercased host), and a provider's error body can echo a part alone, so each part is
// removed on its own too. Root entry: no runtime web3.
import { PUBLIC_RPC_URLS } from "./config.js";

// Shorter usernames, path segments and query values (`v1`, a `?v=1` value) are routing, not keys,
// and would blank common text. A password, a host and the query as a whole go at any length.
const MIN_SECRET_LENGTH = 8;

// Computed per call, not at module scope: every bundle of the root entry would run a top-level one.
const isPublicOrigin = (origin: string): boolean =>
  Object.values(PUBLIC_RPC_URLS).some((u) => new URL(u).origin === origin);

/** `part` percent-decoded, or null when it does not decode. */
function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** `part` percent-encoded, or null when it holds a lone surrogate. */
function encoded(part: string): string | null {
  try {
    return encodeURIComponent(part);
  } catch {
    return null;
  }
}

/**
 * A loopback host carries no key, and an operator needs it to see which local node failed. The
 * WHATWG parser normalises the hostname, so the check is on it exactly: `localhost`, an IPv4
 * address in 127.0.0.0/8 or `[::1]`, never a prefix or suffix of one.
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(hostname)
  );
}

/** The forms of `rpcUrl`, and of each part of it that can hold a key, that text may quote. */
function secretsOf(rpcUrl: string): string[] {
  const secrets = [rpcUrl];
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    // An unparseable URL is removed as written.
    return secrets;
  }
  const long = (part: string | null): string[] =>
    part !== null && part.length >= MIN_SECRET_LENGTH ? [part] : [];
  secrets.push(url.href, url.password, decoded(url.password) ?? "", url.search.slice(1));
  secrets.push(...long(url.username), ...long(decoded(url.username)));
  for (const segment of url.pathname.split("/")) {
    secrets.push(...long(segment), ...long(decoded(segment)));
  }
  for (const pair of url.search.slice(1).split("&")) {
    secrets.push(...long(pair.slice(pair.indexOf("=") + 1)));
  }
  for (const value of url.searchParams.values()) {
    secrets.push(...long(value), ...long(encoded(value)));
  }
  if (!isPublicOrigin(url.origin) && !isLoopback(url.hostname)) {
    secrets.push(url.host, url.hostname, ...long(url.hostname.split(".")[0] ?? ""));
  }
  return secrets;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with each RPC URL, and each of its key-bearing parts, replaced by `replacement`: the URL
 * as written and as its href (loopback included); the password at any length, as written and
 * decoded; the username, path segments and query values of 8 characters or more, as written and
 * decoded; the query as a whole; and a private host (not a public RPC origin, not loopback) with
 * and without its port, and its first label. One pass, longest match first, so a replacement is
 * never itself rewritten. It never throws: an error path that throws can fall through to an
 * unredacted print.
 */
export function redactRpcUrl(
  text: string,
  rpcUrls: readonly (string | undefined)[],
  replacement = "<rpcUrl>",
): string {
  const secrets = new Set<string>();
  for (const rpcUrl of rpcUrls) {
    if (rpcUrl === undefined || rpcUrl === "") continue;
    for (const secret of secretsOf(rpcUrl)) if (secret !== "") secrets.add(secret);
  }
  if (secrets.size === 0) return text;
  const pattern = [...secrets]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return text.replace(new RegExp(pattern, "g"), () => replacement);
}
