import { z } from "zod";
import {
  ADAPTER_IDS,
  DEFAULT_ADAPTER,
  DEFAULT_NETWORK,
  NETWORKS,
  TEMPLATES,
  type AdapterId,
  type BotTemplate,
  type ResolvedOptions,
  type SolanaCluster,
} from "./config.js";
import { LOOPBACK_HOSTS, capabilityFor } from "./register.js";

export interface OptionFlags {
  name?: string | undefined;
  template?: BotTemplate | undefined;
  adapter?: AdapterId | undefined;
  network?: SolanaCluster | undefined;
  confirmMainnet?: boolean | undefined;
  spendCap?: number | undefined;
  /** Funnel telemetry; false only when --no-telemetry is passed. */
  telemetry?: boolean | undefined;
  fromMcp?: string | undefined;
  tools?: string[] | undefined;
}

export interface OptionResolvers {
  name: () => Promise<string>;
  template: () => Promise<BotTemplate>;
  adapter: () => Promise<AdapterId>;
  network: () => Promise<SolanaCluster>;
  // Mainnet-only prompts; consulted only when the resolved network is mainnet.
  confirmMainnet?: () => Promise<boolean>;
  spendCap?: () => Promise<number>;
}

// A bot name is also the generated directory and package name: keep it to the
// npm-safe lowercase set so `pnpm dev` and any later publish work unchanged.
const OptionsSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/,
      "Bot name must be lowercase and start with a letter or number (letters, numbers, '.', '-', '_').",
    ),
  template: z.enum(TEMPLATES as [BotTemplate, ...BotTemplate[]]),
  adapter: z.enum(ADAPTER_IDS as [AdapterId, ...AdapterId[]]),
  network: z.enum(NETWORKS as [SolanaCluster, ...SolanaCluster[]]),
  spendCapUsdc: z.number().positive().finite().optional(),
});

const WORKER_SPEND_CAP_NOTICE =
  "--spend-cap applies only to a BuyerBot; this WorkerBot ignores it.";

/**
 * Refuses, in one line, a cap the generated bot would refuse at start: its config takes a
 * `positive()` number that @escro/sdk's `parseUsdc(String(cap))` reads as integer micro-USDC
 * (digits, at most six decimals, a safe integer). Restated here because the published CLI cannot
 * import @escro/sdk (a devDependency only).
 */
function assertSpendCap(cap: number): void {
  if (!(cap > 0)) {
    throw new Error(`The spend cap must be a positive USDC amount, got ${String(cap)}.`);
  }
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(cap));
  const micro =
    match === null
      ? undefined
      : BigInt(match[1] ?? "") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (micro === undefined || micro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `The spend cap must be a USDC amount with at most six decimals, got ${String(cap)}.`,
    );
  }
}

// The directory takes at most this many capabilities, and a confirmed tool is one capability.
const MAX_MCP_TOOLS = 32;
// The MCP specification's tool-name rule.
const MCP_TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Refuses a server URL that names no server or could write a secret to a committed file. */
function assertMcpServerUrl(raw: string): void {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (url === undefined) {
    throw new Error(`--from-mcp expects a server URL, got "${raw}".`);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) {
    throw new Error(`--from-mcp needs an https URL, or http on loopback (got ${url.protocol}).`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(
      "--from-mcp refuses a URL with credentials, a query or a fragment: it is written to escro.mcp.json.",
    );
  }
}

function assertMcpTools(serverUrl: string, tools: string[]): void {
  if (tools.length > MAX_MCP_TOOLS) {
    throw new Error(
      `--tools takes at most ${String(MAX_MCP_TOOLS)} tools (got ${String(tools.length)}).`,
    );
  }
  for (const tool of tools) {
    if (!MCP_TOOL_NAME.test(tool)) {
      throw new Error(`--tools: "${tool}" is not a valid MCP tool name.`);
    }
    capabilityFor(serverUrl, tool);
  }
}

/**
 * Merge parsed flags with interactive answers into a validated option set.
 *
 * When `resolvers` is omitted (non-interactive / CI), a missing required field
 * (name, template) throws; `adapter` and `network` fall back to their defaults.
 *
 * Mainnet is a deliberate opt-in: it requires an explicit confirmation (the
 * `--confirm-mainnet` flag, or the interactive typed confirmation), and a
 * BuyerBot additionally requires a `spendCapUsdc` it will enforce client-side.
 * A BuyerBot on devnet takes `--spend-cap` when given; a WorkerBot ignores it and
 * `notice` says so once. Any missing requirement or cap the bot would refuse at
 * start throws BEFORE anything is scaffolded, so such a run writes nothing.
 */
export async function resolveOptions(
  flags: OptionFlags,
  resolvers?: OptionResolvers,
  notice: (line: string) => void = console.log,
): Promise<ResolvedOptions> {
  if (flags.tools !== undefined && flags.fromMcp === undefined) {
    throw new Error("--tools needs --from-mcp.");
  }
  if (flags.fromMcp !== undefined) {
    assertMcpServerUrl(flags.fromMcp);
    assertMcpTools(flags.fromMcp, flags.tools ?? []);
    if (flags.adapter !== undefined && flags.adapter !== "custom") {
      throw new Error(`--from-mcp uses the custom adapter; remove --adapter ${flags.adapter}.`);
    }
  }

  const name = flags.name ?? (resolvers ? await resolvers.name() : undefined);
  if (name === undefined) {
    throw new Error("A bot name is required. Usage: create-escro-bot <name> [options]");
  }

  const template = flags.template ?? (resolvers ? await resolvers.template() : undefined);
  if (template === undefined) {
    throw new Error("A template is required. Pass --template worker|buyer.");
  }

  if (flags.fromMcp !== undefined && template !== "worker") {
    throw new Error("--from-mcp scaffolds a worker: it cannot be used with --template buyer.");
  }

  const adapter =
    flags.adapter ??
    (flags.fromMcp !== undefined
      ? "custom"
      : resolvers
        ? await resolvers.adapter()
        : DEFAULT_ADAPTER);
  const network = flags.network ?? (resolvers ? await resolvers.network() : DEFAULT_NETWORK);

  let spendCapUsdc: number | undefined;
  if (network === "mainnet") {
    const confirmed =
      flags.confirmMainnet ??
      (resolvers?.confirmMainnet ? await resolvers.confirmMainnet() : false);
    if (!confirmed) {
      throw new Error(
        "Mainnet moves real funds and must be confirmed. Re-run with --confirm-mainnet (or confirm the prompt).",
      );
    }
    if (template === "buyer") {
      spendCapUsdc =
        flags.spendCap ?? (resolvers?.spendCap ? await resolvers.spendCap() : undefined);
      if (spendCapUsdc === undefined) {
        throw new Error(
          "A mainnet BuyerBot requires a spend cap. Pass --spend-cap <usdc> (the bot enforces it before every escrow).",
        );
      }
    }
  } else if (template === "buyer") {
    spendCapUsdc = flags.spendCap;
  }
  if (template === "worker" && flags.spendCap !== undefined) {
    notice(WORKER_SPEND_CAP_NOTICE);
  }
  // One line, before the schema's issue dump.
  if (spendCapUsdc !== undefined) assertSpendCap(spendCapUsdc);

  const parsed = OptionsSchema.parse(
    spendCapUsdc === undefined
      ? { name, template, adapter, network }
      : { name, template, adapter, network, spendCapUsdc },
  );

  const plain: ResolvedOptions =
    parsed.spendCapUsdc === undefined
      ? {
          name: parsed.name,
          template: parsed.template,
          adapter: parsed.adapter,
          network: parsed.network,
        }
      : {
          name: parsed.name,
          template: parsed.template,
          adapter: parsed.adapter,
          network: parsed.network,
          spendCapUsdc: parsed.spendCapUsdc,
        };

  const base: ResolvedOptions =
    flags.fromMcp === undefined
      ? plain
      : { ...plain, mcp: { serverUrl: flags.fromMcp, tools: flags.tools ?? [] } };

  // Telemetry is on unless explicitly opted out (--no-telemetry). Only the
  // opt-out is threaded through; the default stays implicit (absent === on).
  return flags.telemetry === false ? { ...base, telemetry: false } : base;
}
