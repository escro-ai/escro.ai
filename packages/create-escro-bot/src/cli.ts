import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_ESCROW_AMOUNT, getApiUrl } from "@escro/shared";
import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { z } from "zod";
import { ADAPTER_DESCRIPTORS, ADAPTER_IDS, DEFAULT_NETWORK, NETWORKS } from "./config.js";
import { parseArgs } from "./args.js";
import { capabilityFor, confirmDiscoverable, mcpClaim, registerBot } from "./register.js";
import { resolveOptions, type OptionResolvers } from "./resolve.js";
import { formatReport } from "./report.js";
import { scaffold } from "./scaffold.js";
import {
  FunnelTelemetry,
  NULL_SINK,
  escroDir,
  eventsPath,
  fileSink,
  readEvents,
  writeSession,
} from "./telemetry.js";
import { generateWallet } from "./wallet.js";

const HELP = `create-escro-bot: scaffold an Escro bot in one command

Usage:
  npx create-escro-bot <name> [options]

Options:
  -t, --template <worker|buyer>                 Bot template
  -a, --adapter  <gradients|ridges|404gen|lium|akash|render|gensyn|zkml|custom>   Service adapter
  -n, --network  <devnet|mainnet>               Cluster (default: devnet)
      --confirm-mainnet                         Confirm real funds (required with --network mainnet)
      --spend-cap <usdc>                        BuyerBot cap on amount plus fee across open escrows (required for mainnet buyer)
      --from-mcp <url>                          Wrap an MCP server as a worker (https, or http on loopback)
      --tools <a,b>                             The MCP tools this worker sells (with --from-mcp)
      --register-mcp                            Re-register the tools in ./escro.mcp.json in EscroBots
      --api-url <url>                           Registry/API base URL (default: per-cluster)
      --no-register                             Skip EscroBots registration
      --no-telemetry                            Disable anonymous funnel events
      --report                                  Print funnel timings from ./.escro (TTFE, discoverable time)
  -h, --help                                    Show this help
  -v, --version                                 Print the version

Prompts fill anything not passed as a flag. Devnet is the default everywhere.
A wallet keypair is generated locally under ./wallet (gitignored, 0600). The kit
never accepts a pasted private key and never logs key material.`;

function readVersion(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * The package manager that ran this scaffold, from the `npm_config_user_agent` it sets for a bin it
 * runs (`pnpm/10.20.0 npm/? node/...`); npm when there is none, the one every Node install ships.
 */
function packageManager(): PackageManager {
  const name = (process.env.npm_config_user_agent ?? "").split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Scaffold cancelled.");
    process.exit(1);
  }
  return value;
}

function interactiveResolvers(): OptionResolvers {
  return {
    name: async () =>
      unwrap(await text({ message: "Bot name?", placeholder: "my-bot", defaultValue: "my-bot" })),
    template: async () =>
      unwrap(
        await select({
          message: "Template?",
          options: [
            { value: "buyer", label: "Buyer (raise jobs)" },
            { value: "worker", label: "Worker (do jobs)" },
          ],
        }),
      ),
    adapter: async () =>
      unwrap(
        await select({
          message: "Capability / adapter?",
          options: ADAPTER_IDS.map((id) => ({ value: id, label: id })),
        }),
      ),
    network: async () =>
      unwrap(
        await select({
          message: "Network?",
          initialValue: DEFAULT_NETWORK,
          options: [
            { value: "devnet", label: "Devnet (default)" },
            { value: "mainnet", label: "Mainnet (real funds)" },
          ],
        }),
      ),
    confirmMainnet: async () => {
      const answer = unwrap(
        await text({ message: 'Mainnet moves REAL funds. Type "mainnet" to confirm:' }),
      );
      return answer.trim() === "mainnet";
    },
    spendCap: async () => {
      const answer = unwrap(
        await text({
          message:
            "Spend cap in USDC (max amount plus fee the buyer may lock across open escrows):",
          placeholder: "100",
        }),
      );
      return Number(answer);
    },
  };
}

const McpManifestSchema = z.object({
  server: z.string().url(),
  network: z.enum(NETWORKS as ["devnet", "mainnet"]),
  tools: z.array(z.string()).min(1, "no tools are confirmed").max(32),
  publicUrl: z.string().url().nullable(),
});

/** `--register-mcp`: lists the current project's confirmed tools in EscroBots. */
async function registerFromManifest(
  apiUrlFlag: string | undefined,
  cwd: string,
  fetchImpl: typeof fetch | undefined,
): Promise<void> {
  const manifestPath = join(cwd, "escro.mcp.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No escro.mcp.json in ${cwd}: run --register-mcp in an MCP worker's project.`);
  }
  const parsed = McpManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`escro.mcp.json is not valid: ${reasons.join("; ")}`);
  }
  const manifest = parsed.data;
  const walletDir = join(cwd, "wallet");
  const secretKey = JSON.parse(readFileSync(join(walletDir, "keypair.json"), "utf8")) as number[];
  const { publicKey } = nacl.sign.keyPair.fromSecretKey(Uint8Array.from(secretKey));
  const apiUrl = apiUrlFlag ?? process.env.ESCRO_API_URL ?? getApiUrl(manifest.network);
  const { listingUrl } = await registerBot({
    walletDir,
    walletAddress: bs58.encode(publicKey),
    role: "worker",
    adapter: "custom",
    apiUrl,
    claim: mcpClaim(manifest.server, manifest.tools, manifest.publicUrl ?? undefined),
    ...(fetchImpl !== undefined && { fetchImpl }),
  });
  console.log(`Registered ${String(manifest.tools.length)} tool(s) in EscroBots: ${listingUrl}`);
}

export async function runCli(
  argv: string[],
  opts: { cwd?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(readVersion());
    return;
  }
  if (args.report) {
    // Read the current project's funnel and print its timings. This is the
    // shipped surface that makes TTFE / registered->discoverable readable from a
    // real clean-machine run, computed from the local .escro/events.jsonl.
    const dir = escroDir(resolve(opts.cwd ?? process.cwd()));
    console.log(formatReport(readEvents(eventsPath(dir))));
    return;
  }
  if (args.registerMcp) {
    await registerFromManifest(args.apiUrl, resolve(opts.cwd ?? process.cwd()), opts.fetchImpl);
    return;
  }

  const interactive = process.stdin.isTTY;
  if (interactive) {
    intro("create-escro-bot");
  }

  const options = await resolveOptions(
    {
      name: args.name,
      template: args.template,
      adapter: args.adapter,
      network: args.network,
      confirmMainnet: args.confirmMainnet,
      spendCap: args.spendCap,
      telemetry: args.telemetry,
      fromMcp: args.fromMcp,
      tools: args.tools,
    },
    interactive ? interactiveResolvers() : undefined,
  );

  const targetDir = resolve(opts.cwd ?? process.cwd(), options.name);
  scaffold(options, targetDir);
  // Generate the local wallet after the file tree exists. Only the public key is
  // surfaced here; the secret bytes stay in the keyfile. Registration below reads
  // them in a scoped helper (register.ts) that signs and discards them, never
  // returning or logging key material.
  const wallet = generateWallet(join(targetDir, "wallet"));

  // Anonymous funnel: stamp `scaffolded` and persist the opaque runId so the
  // running bot's later stages (started -> ... -> settled) join the same funnel.
  // --no-telemetry (options.telemetry === false) writes nothing at all.
  const telemetryEnabled = options.telemetry !== false;
  const runId = randomUUID();
  const telemetryDir = escroDir(targetDir);
  if (telemetryEnabled) {
    writeSession(telemetryDir, { runId, path: options.template, enabled: true });
  }
  const funnel = new FunnelTelemetry({
    path: options.template,
    runId,
    enabled: telemetryEnabled,
    sink: telemetryEnabled ? fileSink(eventsPath(telemetryDir)) : NULL_SINK,
  });
  funnel.stage("scaffolded");

  const summary = `Scaffolded ${options.name} (${options.template}, ${options.network}).`;
  if (interactive) {
    outro(summary);
  } else {
    console.log(summary);
  }
  console.log(
    `Wallet generated locally at ./wallet (gitignored, 0600). Address: ${wallet.publicKey}`,
  );

  // EscroBots registration (opt-out via --no-register). Discovery is a hard
  // dependency of the buyer worker-picker (an escrow names its worker), so a new bot is
  // registered the moment it is scaffolded. The default API base resolves from
  // the cluster; --api-url / ESCRO_API_URL override it (self-hosters, localnet).
  // Failure is non-fatal: generateWallet refuses to overwrite an existing key,
  // so aborting here would make a re-run a hard failure; the bot works either
  // way and can re-register later.
  const apiUrl = args.apiUrl ?? process.env.ESCRO_API_URL ?? getApiUrl(options.network);
  const mcp = options.mcp;
  const pm = packageManager();
  if (args.register && mcp?.tools.length === 0) {
    console.log(
      `Not listed in EscroBots yet: no tools are confirmed. List them with ${pm} run mcp:tools, set ` +
        "tools in escro.mcp.json, then run npx create-escro-bot --register-mcp.",
    );
  } else if (args.register) {
    try {
      const { listingUrl } = await registerBot({
        walletDir: join(targetDir, "wallet"),
        walletAddress: wallet.publicKey,
        role: options.template,
        adapter: options.adapter,
        apiUrl,
        ...(mcp !== undefined && { claim: mcpClaim(mcp.serverUrl, mcp.tools) }),
        ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
      });
      console.log(`Registered in EscroBots. See your listing: ${listingUrl}`);

      // Worker funnel: registration succeeded (registered) -> confirm the listing
      // is actually retrievable under the picker's filters (discoverable). Only the
      // worker path measures this leg; a buyer registers but is not "discovered".
      // Gated on telemetry: the discovery GET exists solely to time this leg, so
      // --no-telemetry must not fire an extra registry probe.
      if (options.template === "worker" && telemetryEnabled) {
        funnel.stage("registered");
        const discoverable = await confirmDiscoverable({
          apiUrl,
          wallet: wallet.publicKey,
          role: "worker",
          capability:
            mcp !== undefined
              ? capabilityFor(mcp.serverUrl, mcp.tools[0] ?? "")
              : (ADAPTER_DESCRIPTORS[options.adapter].capabilities[0] ?? ""),
          ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
        });
        if (discoverable) funnel.stage("discoverable");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `EscroBots registration did not complete (${message}). Your bot still works; ` +
          `re-run registration later. Directory: ${apiUrl}/v1/bots/listing`,
      );
    }
  } else {
    console.log(
      `Skipped EscroBots registration (--no-register). Register later to be discoverable at ${apiUrl}/v1/bots/listing`,
    );
  }

  console.log(`\nNext:\n  cd ${options.name}\n  ${pm} install\n  ${pm} run dev\n`);

  if (options.network === "mainnet") {
    const minUsdc = (MIN_ESCROW_AMOUNT / 1_000_000).toFixed(2);
    console.log(
      `Mainnet selected: real USDC will move. The $${minUsdc} on-chain minimum applies to every escrow.`,
    );
    if (options.spendCapUsdc === undefined) {
      console.log(
        "WorkerBot earnings settle in USDC on release; you front the underlying service cost from your own wallet until then.",
      );
    }
  }
  if (options.spendCapUsdc !== undefined) {
    console.log(
      `Spend cap: ${String(options.spendCapUsdc)} USDC. The BuyerBot refuses to create an escrow whose amount plus fee would push its open escrows' deposits over this cap.`,
    );
  }
  if (options.network === "mainnet" || options.spendCapUsdc !== undefined) console.log("");
}
