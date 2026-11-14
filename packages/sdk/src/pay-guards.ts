// The guards a surface that lets an agent call pay() applies before it does: the URL's host must be
// public, and an escrow entry's deadline must fall within a bound; and the address rule it hands
// pay() so the transport judges what it connects to. pay() itself stays policy-free about hosts.
// This module resolves nothing: the caller passes its own resolver, so this file carries no
// node:dns import.
import { SOLANA_CAIP2_DEVNET, SOLANA_CAIP2_MAINNET } from "@escro/shared";

import { EscroError, EscroPayError } from "./errors.js";
import type { PayParams, PayPolicy } from "./payments.js";
import type { EscroOptions } from "./types.js";

/** Why {@link payUrlRefusal} refuses a URL; each surface turns a kind into its own sentence. */
export type PayUrlRefusal = "private_host" | "unresolved_host" | "mainnet_http";

/** node:dns/promises' lookup satisfies it; the SDK resolves nothing itself. */
export type HostLookup = (
  hostname: string,
  options: { all: true },
) => Promise<readonly { address: string }[]>;

/** A strict dotted quad: four decimal octets, no leading zero, nothing else. */
function parseIpv4(text: string): number | null {
  const octets = text.split(".");
  if (octets.length !== 4) return null;
  let n = 0;
  for (const octet of octets) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255) return null;
    n = n * 256 + Number(octet);
  }
  return n;
}

/** The 16-bit groups of one side of an IPv6 `::`; a dotted IPv4 tail only as the address's last field. */
function ipv6Groups(side: string, holdsTail: boolean): number[] | null {
  if (side === "") return [];
  const fields = side.split(":");
  const groups: number[] = [];
  for (const [i, field] of fields.entries()) {
    if (holdsTail && i === fields.length - 1 && field.includes(".")) {
      const v4 = parseIpv4(field);
      if (v4 === null) return null;
      groups.push(Math.floor(v4 / 0x10000), v4 % 0x10000);
    } else if (/^[0-9a-f]{1,4}$/i.test(field)) {
      groups.push(parseInt(field, 16));
    } else {
      return null;
    }
  }
  return groups;
}

/** An IPv6 address without brackets, hex or dotted-tail; a zone id, or any other character, does not parse. */
function parseIpv6(text: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(text)) return null;
  const sides = text.split("::");
  if (sides.length > 2) return null;
  const [head = "", tail] = sides;
  const left = ipv6Groups(head, tail === undefined);
  const right = tail === undefined ? [] : ipv6Groups(tail, true);
  if (left === null || right === null) return null;
  const explicit = left.length + right.length;
  if (tail === undefined ? explicit !== 8 : explicit > 7) return null;
  const groups = [...left, ...new Array<number>(8 - explicit).fill(0), ...right];
  return groups.reduce((n, group) => (n << 16n) | BigInt(group), 0n);
}

interface Ipv4Range {
  base: number;
  bits: number;
}
interface Ipv6Range {
  base: bigint;
  bits: number;
}

function ipv4Range(cidr: string): Ipv4Range {
  const [address = "", bits = ""] = cidr.split("/");
  const base = parseIpv4(address);
  if (base === null) throw new Error(`the refused set holds an unparseable range ${cidr}`);
  return { base, bits: Number(bits) };
}

function ipv6Range(cidr: string): Ipv6Range {
  const [address = "", bits = ""] = cidr.split("/");
  const base = parseIpv6(address);
  if (base === null) throw new Error(`the refused set holds an unparseable range ${cidr}`);
  return { base, bits: Number(bits) };
}

const inIpv4Range = (n: number, { base, bits }: Ipv4Range): boolean =>
  Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));

const inIpv6Range = (n: bigint, { base, bits }: Ipv6Range): boolean =>
  n >> BigInt(128 - bits) === base >> BigInt(128 - bits);

/** Every IPv4 range a pay action does not reach without the operator's opt-in. */
const REFUSED_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "168.63.129.16/32",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map(ipv4Range);

/** Every IPv6 range refused whole; Teredo and 6to4 each embed an IPv4 address a relay reaches. */
const REFUSED_IPV6 = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
  "2001::/32",
  "2002::/16",
  "64:ff9b:1::/48",
].map(ipv6Range);

/** IPv4-mapped, IPv4-compatible and NAT64: an address here is classed by its embedded IPv4 address. */
const IPV4_EMBEDDINGS = ["::ffff:0:0/96", "::/96", "64:ff9b::/96"].map(ipv6Range);

/**
 * True only for text that parses as an IPv4 or IPv6 address (no brackets, no zone id) outside the
 * refused set, so an unknown form (a name, a zone id, a non-strict quad) is never public.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return !REFUSED_IPV4.some((range) => inIpv4Range(v4, range));
  const v6 = parseIpv6(address);
  if (v6 === null) return false;
  if (REFUSED_IPV6.some((range) => inIpv6Range(v6, range))) return false;
  if (IPV4_EMBEDDINGS.some((range) => inIpv6Range(v6, range))) {
    return isPublicAddress(
      [24n, 16n, 8n, 0n].map((shift) => String((v6 >> shift) & 0xffn)).join("."),
    );
  }
  return true;
}

/** RFC 6761 section 6.3: these names are loopback and are never looked up. */
function isLocalhostName(hostname: string): boolean {
  const name = (hostname.endsWith(".") ? hostname.slice(0, -1) : hostname).toLowerCase();
  return name === "localhost" || name.endsWith(".localhost");
}

/** A literal or `localhost` host's class without a lookup; null for a name that must be resolved. */
function literalReach(hostname: string): "public" | "private" | null {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isPublicAddress(hostname.slice(1, -1)) ? "public" : "private";
  }
  if (parseIpv4(hostname) !== null) return isPublicAddress(hostname) ? "public" : "private";
  if (isLocalhostName(hostname)) return "private";
  return null;
}

/**
 * A name's class from one resolution, or null when the lookup rejects or answers nothing. A name
 * re-pointed between this check and the request (DNS rebinding) is not caught here.
 */
async function nameReach(
  hostname: string,
  lookup: HostLookup,
): Promise<"public" | "private" | "mixed" | null> {
  let answers: readonly { address: string }[];
  try {
    answers = await lookup(hostname, { all: true });
  } catch {
    return null;
  }
  if (answers.length === 0) return null;
  const publicCount = answers.filter(({ address }) => isPublicAddress(address)).length;
  if (publicCount === answers.length) return "public";
  return publicCount === 0 ? "private" : "mixed";
}

/**
 * Whether a pay action may reach `url`, before any request, signature or funding: on any cluster
 * but devnet an `http:` URL to a host the operator has not admitted as private is refused, and
 * without the opt-in any host that is not public is refused. Null admits, and leaves a URL that does
 * not parse, or is not http or https, to pay()'s own refusal. Resolves the host at most once, and
 * only when the answer decides.
 */
export async function payUrlRefusal(
  url: string,
  options: {
    cluster: EscroOptions["cluster"] | undefined;
    allowPrivateHosts: boolean;
    lookup: HostLookup;
  },
): Promise<PayUrlRefusal | null> {
  if (!URL.canParse(url)) return null;
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") return null;
  const allowPrivate = options.allowPrivateHosts;
  const mainnetHttp = options.cluster !== "devnet" && protocol === "http:";
  if (mainnetHttp && !allowPrivate) return "mainnet_http";
  if (allowPrivate && !mainnetHttp) return null;
  const literal = literalReach(hostname);
  if (!allowPrivate && literal === "private") return "private_host";
  const reach = literal ?? (await nameReach(hostname, options.lookup));
  if (reach === null) return "unresolved_host";
  if (!allowPrivate) return reach === "public" ? null : "private_host";
  // https: is required on mainnet for a public network path; a host the operator declared local has none.
  return reach === "private" ? null : "mainnet_http";
}

/**
 * The address rule a surface passes as PayParams.admitAddress, for the URL it checked with
 * {@link payUrlRefusal}. Without the opt-in both targets admit exactly the public addresses. With it,
 * on any cluster but devnet over http:, the resource admits exactly the addresses that are not
 * public (a host the operator declared local has no public network path) and the spec host, always
 * https:, admits every address. With the opt-in otherwise there is no rule (undefined). A URL that
 * does not parse, or is not http or https, takes the rule without the opt-in.
 */
export function payAddressRule(options: {
  cluster: EscroOptions["cluster"] | undefined;
  allowPrivateHosts: boolean;
  url: string;
}): PayParams["admitAddress"] {
  const publicOnly = (address: string): boolean => isPublicAddress(address);
  if (!URL.canParse(options.url)) return publicOnly;
  const { protocol } = new URL(options.url);
  if (protocol !== "http:" && protocol !== "https:") return publicOnly;
  if (!options.allowPrivateHosts) return publicOnly;
  if (options.cluster !== "devnet" && protocol === "http:") {
    return (address, target) => target === "spec" || !isPublicAddress(address);
  }
  return undefined;
}

const ESCROW_RAIL_SCHEMES: readonly string[] = ["on-delivery", "job-escrow"];

/**
 * pay()'s own rail choice with a deadline bound added: an escrow entry on the caller's terms is
 * returned only when its deadline is at most now plus `maxDeadlineSeconds`, and is never passed over
 * for an `exact` entry; an `exact` entry is returned only when no escrow entry is on the terms, and
 * never with `escrowOnly`. Only entries on the cluster's network are on the terms: devnet's for
 * `"devnet"`, mainnet's for any other value, as {@link payUrlRefusal} reads a cluster. Refusals carry
 * the caller's values only, never the 402's text. The clock (`now`, milliseconds, default
 * `Date.now`) is read each time the policy runs, which pay() does before its first chain read, spec
 * fetch or signature.
 */
export function deadlineBoundedPolicy(terms: {
  to: string;
  amountMicroUsdc: number;
  cluster: EscroOptions["cluster"] | undefined;
  maxDeadlineSeconds: number;
  escrowOnly?: boolean;
  now?: () => number;
}): PayPolicy {
  const bound = terms.maxDeadlineSeconds;
  if (!Number.isSafeInteger(bound) || bound < 1) {
    throw new EscroError(
      `maxDeadlineSeconds must be a positive whole number of seconds, got ${String(bound)}`,
      "VALIDATION_ERROR",
    );
  }
  const escrowOnly: unknown = terms.escrowOnly;
  if (escrowOnly !== undefined && typeof escrowOnly !== "boolean") {
    throw new EscroError(
      `escrowOnly must be true, false or absent, got ${typeof escrowOnly}`,
      "VALIDATION_ERROR",
    );
  }
  // Date is looked up on each run, not captured here, so a Date replaced after the build is the one read.
  const now = terms.now ?? (() => Date.now());
  const amount = String(terms.amountMicroUsdc);
  const network = terms.cluster === "devnet" ? SOLANA_CAIP2_DEVNET : SOLANA_CAIP2_MAINNET;
  return (accepts) => {
    const reading: unknown = now();
    if (typeof reading !== "number" || !Number.isSafeInteger(reading)) {
      throw new EscroError(
        "The pay policy's clock must return whole milliseconds; nothing was signed or funded",
        "VALIDATION_ERROR",
      );
    }
    const latest = Math.floor(reading / 1000) + bound;
    const onTerms = accepts.filter(
      (entry) => entry.payTo === terms.to && entry.amount === amount && entry.network === network,
    );
    const escrowEntries = onTerms.filter((entry) => ESCROW_RAIL_SCHEMES.includes(entry.scheme));
    if (escrowEntries.length > 0) {
      const inBound = escrowEntries.find((entry) => {
        const deadline = entry.extra?.deadline;
        return typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline <= latest;
      });
      if (inBound !== undefined) return inBound;
      throw new EscroPayError(
        "no_eligible_entry",
        "The 402 offers no escrow entry paying this worker this amount with a deadline at or before " +
          `${String(latest)} (Unix seconds: now plus ${String(bound)}). Nothing was signed or funded.`,
        { detail: "deadline" },
      );
    }
    if (escrowOnly === true) {
      throw new EscroPayError(
        "no_eligible_entry",
        `The 402 offers no escrow entry paying ${amount} micro-USDC to ${terms.to}. Nothing was signed or funded.`,
        { detail: "escrow_only" },
      );
    }
    const exact = onTerms.find((entry) => entry.scheme === "exact");
    if (exact !== undefined) return exact;
    const [first] = onTerms;
    // An unknown scheme is never returned: the router's refusal would repeat the 402's scheme text.
    if (first !== undefined && onTerms.every((entry) => entry.scheme === "upto")) return first;
    throw new EscroPayError(
      "no_eligible_entry",
      `The 402 offers no entry paying ${amount} micro-USDC to ${terms.to}`,
    );
  };
}
