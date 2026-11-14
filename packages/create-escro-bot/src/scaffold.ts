import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedOptions } from "./config.js";

// templates/ ships alongside the built bundle: `../templates` resolves to the
// package root both from src/ (tests) and from dist/index.js (published bin).
const TEMPLATES_ROOT = fileURLToPath(new URL("../templates", import.meta.url));

// Files renamed on the way out (dotfiles can't live in an npm-published tree
// verbatim, and keeping them undotted keeps them out of the package's own
// tooling globs).
const RENAMES: Record<string, string> = {
  gitignore: ".gitignore",
  "env.example": ".env.example",
};

// The workspace package's version, a published dependency of the generated worker. A test fails
// when it drifts from packages/x402-middleware/package.json.
const X402_MIDDLEWARE_RANGE = "^0.1.0";

// A flagged worker's only extra dependency. A test fails when it drifts from the MCP SDK range in
// packages/mcp/package.json.
export const MCP_SDK_RANGE = "^1.32.2";

// Current pnpm fails an install on a build script nobody ruled on, and honours these two settings
// only from this file (not package.json or .npmrc). The three names are the install scripts web3.js brings in; none is
// needed, since each falls back to pure JS or a shipped prebuild. The project ships no lockfile, so
// a later release can add a script: strictDepBuilds false keeps that a warning, and it still does
// not run. pnpm 9 and 10.0.0 refuse this file without `packages`.
const PNPM_WORKSPACE_FILE = `packages: ["."]
strictDepBuilds: false
allowBuilds:
  bigint-buffer: false
  bufferutil: false
  utf-8-validate: false
`;

function renderConfig(source: string, options: ResolvedOptions): string {
  let out = source
    .replace(/name: "[^"]*"/, `name: ${JSON.stringify(options.name)}`)
    .replace(/network: "[^"]*"/, `network: "${options.network}"`)
    .replace(/template: "[^"]*"/, `template: "${options.template}"`)
    .replace(/adapter: "[^"]*"/, `adapter: "${options.adapter}"`);
  // The buyer template carries a `spendCapUsdc: undefined` placeholder; a buyer
  // with a resolved cap (required on mainnet, optional on devnet) replaces it.
  if (options.spendCapUsdc !== undefined) {
    out = out.replace("spendCapUsdc: undefined", `spendCapUsdc: ${String(options.spendCapUsdc)}`);
  }
  // Templates ship telemetry ON; --no-telemetry (options.telemetry === false)
  // bakes the opt-out into the generated config so the bot is born silent.
  if (options.telemetry === false) {
    out = out.replace("telemetry: true", "telemetry: false");
  }
  return out;
}

function renderPackageJson(options: ResolvedOptions): string {
  const dependencies: Record<string, string> = {
    // The MCP SDK declares zod ^3.25 as its peer.
    zod: options.mcp === undefined ? "^3.23.8" : "^3.25.0",
  };
  // The SDK floor is the release whose createEscrow enforces the spend cap and refuses a mainnet create without one; it also checks a
  // server-built transaction before signing it.
  dependencies["@escro/sdk"] = "^0.5.0";
  dependencies["@solana/web3.js"] = "^1.95.8";
  // Always present for a worker, flag on or off, so turning on serve402 needs no install step.
  if (options.template === "worker") {
    dependencies["@escro/x402-middleware"] = X402_MIDDLEWARE_RANGE;
  }
  if (options.mcp !== undefined) {
    dependencies["@modelcontextprotocol/sdk"] = MCP_SDK_RANGE;
  }
  const pkg = {
    name: options.name,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ">=22" },
    scripts: {
      // `tsc && node` adds no dependency that needs a build script (esbuild via tsx would, and
      // pnpm 10 and later do not run it). typescript (its native binary ships as an optional
      // dependency) and @types/node declare no install scripts under any package manager.
      dev: "tsc && node dist/src/bot.js",
      start: "node dist/src/bot.js",
      build: "tsc",
      typecheck: "tsc --noEmit",
      ...(options.mcp !== undefined && { "mcp:tools": "tsc && node dist/src/mcp-tools.js" }),
    },
    dependencies,
    devDependencies: {
      "@types/node": "^26.6.5",
      typescript: "^7.0.2",
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function renderMcpManifest(
  options: ResolvedOptions,
  mcp: NonNullable<ResolvedOptions["mcp"]>,
): string {
  const manifest = {
    server: mcp.serverUrl,
    network: options.network,
    tools: mcp.tools,
    publicUrl: null,
    pricing: {},
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function copyTree(sourceDir: string, targetDir: string, options: ResolvedOptions): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = join(sourceDir, entry.name);
    const outName = RENAMES[entry.name] ?? entry.name;
    const to = join(targetDir, outName);
    if (entry.isDirectory()) {
      copyTree(from, to, options);
      continue;
    }
    const raw = readFileSync(from, "utf8");
    const contents = entry.name === "escro.config.ts" ? renderConfig(raw, options) : raw;
    writeFileSync(to, contents);
  }
}

/**
 * Materialise a generated bot project into `targetDir` from the chosen
 * template. Copies the template tree verbatim (renaming gitignore/env.example),
 * rewrites escro.config.ts for the chosen options, emits package.json and
 * pnpm-workspace.yaml, and creates the gitignored wallet/ directory the wallet step fills.
 */
export function scaffold(options: ResolvedOptions, targetDir: string): void {
  const variantDir = join(TEMPLATES_ROOT, options.template);
  mkdirSync(dirname(targetDir), { recursive: true });
  copyTree(variantDir, targetDir, options);
  writeFileSync(join(targetDir, "package.json"), renderPackageJson(options));
  writeFileSync(join(targetDir, "pnpm-workspace.yaml"), PNPM_WORKSPACE_FILE);
  if (options.mcp !== undefined) {
    copyTree(join(TEMPLATES_ROOT, "worker-mcp", "src"), join(targetDir, "src"), options);
    writeFileSync(join(targetDir, "escro.mcp.json"), renderMcpManifest(options, options.mcp));
  }
  mkdirSync(join(targetDir, "wallet"), { recursive: true });
}
