import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signBotDescriptor, signRequestRaw } from "@escro/shared";
import type { BotDescriptor, BotRole, UnsignedBotDescriptor } from "@escro/shared";
import { ADAPTER_DESCRIPTORS, type AdapterId } from "./config.js";

const REGISTER_PATH = "/v1/bots";

export interface RegisterInput {
  /** Directory holding the generated `keypair.json` (secret read here, never returned or logged). */
  walletDir: string;
  /** Base58 public key: the descriptor's `wallet` and the authenticated caller. */
  walletAddress: string;
  /** The advertised role - worker or buyer (the scaffolded template). */
  role: BotRole;
  /** Chosen adapter - drives the capability/serviceRef/pricingHint claim. */
  adapter: AdapterId;
  /** Registry API base URL, e.g. `https://api-devnet.escro.ai`. */
  apiUrl: string;
  /** Replaces the adapter's capability claim (an MCP worker's tools). */
  claim?: { capabilities: string[]; serviceRef: string; pricingHint: string; endpoint?: string };
  /** Injection seam for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RegisterResult {
  /** The registered wallet (public key). */
  wallet: string;
  /** Where the developer can see their bot in the public directory. */
  listingUrl: string;
}

/**
 * Read the generated keypair secret in a scoped path that never returns or logs
 * it: only the detached signature and the public descriptor fields leave this
 * module.
 */
function readSecretKey(walletDir: string): Uint8Array {
  const bytes = JSON.parse(readFileSync(join(walletDir, "keypair.json"), "utf8")) as number[];
  return Uint8Array.from(bytes);
}

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MAX_CAPABILITY_LENGTH = 64;

/** The directory capability an MCP tool is listed under. The hostname alone: a URL's path can carry a secret. */
export function capabilityFor(serverUrl: string, tool: string): string {
  const capability = `mcp:${new URL(serverUrl).hostname}/${tool}`;
  if (capability.length > MAX_CAPABILITY_LENGTH) {
    throw new Error(
      `The capability "${capability}" is over the directory's ${String(MAX_CAPABILITY_LENGTH)} character limit.`,
    );
  }
  return capability;
}

/** The claim an MCP worker registers: one capability per confirmed tool. */
export function mcpClaim(
  serverUrl: string,
  tools: string[],
  endpoint?: string,
): NonNullable<RegisterInput["claim"]> {
  return {
    capabilities: tools.map((tool) => capabilityFor(serverUrl, tool)),
    serviceRef: `mcp:${new URL(serverUrl).hostname}`,
    pricingHint: "Priced per tool: the worker's 402 answers each route's price.",
    ...(endpoint !== undefined && { endpoint }),
  };
}

// A request signature replays inside its freshness window: it never crosses a network in clear.
function assertSecureApiUrl(apiUrl: string): void {
  const url = new URL(apiUrl);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new Error(`EscroBots registration needs an https API URL (got ${url.origin})`);
}

/**
 * Register the scaffolded bot in EscroBots (`POST /v1/bots`).
 * Builds and signs the capability descriptor at call time (the API's 60s
 * freshness bound rejects a `signedAt` signed earlier, e.g. at wallet
 * generation), then POSTs it with transport auth. Throws on a non-2xx response;
 * the CLI treats a failure as non-fatal (the bot still works; re-register later).
 */
export async function registerBot(input: RegisterInput): Promise<RegisterResult> {
  assertSecureApiUrl(input.apiUrl);
  const doFetch = input.fetchImpl ?? fetch;
  const claim = input.claim ?? ADAPTER_DESCRIPTORS[input.adapter];

  const unsigned: UnsignedBotDescriptor = {
    wallet: input.walletAddress,
    role: input.role,
    capabilities: claim.capabilities,
    serviceRef: claim.serviceRef,
    pricingHint: claim.pricingHint,
    ...(input.claim?.endpoint !== undefined && { endpoint: input.claim.endpoint }),
    signedAt: Date.now(),
  };

  const secretKey = readSecretKey(input.walletDir);
  const signature = signBotDescriptor(secretKey, unsigned);
  const descriptor: BotDescriptor = { ...unsigned, signature };
  const rawBody = JSON.stringify(descriptor);

  const res = await doFetch(`${input.apiUrl}${REGISTER_PATH}`, {
    method: "POST",
    headers: {
      ...signRequestRaw(secretKey, input.walletAddress, "POST", REGISTER_PATH, rawBody),
      "content-type": "application/json",
    },
    body: rawBody,
  });
  if (!res.ok) {
    throw new Error(`EscroBots registration failed: HTTP ${String(res.status)}`);
  }

  return { wallet: input.walletAddress, listingUrl: `${input.apiUrl}${REGISTER_PATH}/listing` };
}

export interface DiscoverInput {
  /** Registry API base URL. */
  apiUrl: string;
  /** The wallet whose listing we confirm is retrievable. */
  wallet: string;
  /** The role filter to query (a worker confirms it is discoverable as a worker). */
  role: BotRole;
  /** The capability filter a buyer's worker-picker would use. */
  capability: string;
  /** Injection seam for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Confirm the just-registered bot is retrievable via `GET /v1/bots` under the
 * same filters a buyer's worker-picker uses. This closes the worker funnel's
 * registered -> discoverable leg: registration succeeding is not the same as
 * being findable. Returns false (never throws) on any read failure so the caller
 * can treat discovery confirmation as best-effort.
 */
export async function confirmDiscoverable(input: DiscoverInput): Promise<boolean> {
  const doFetch = input.fetchImpl ?? fetch;
  const params = new URLSearchParams({ role: input.role, capability: input.capability });
  try {
    const res = await doFetch(`${input.apiUrl}${REGISTER_PATH}?${params.toString()}`, {
      method: "GET",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { items?: { wallet: string }[] };
    return (body.items ?? []).some((bot) => bot.wallet === input.wallet);
  } catch {
    return false;
  }
}
