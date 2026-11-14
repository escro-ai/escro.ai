// A worker over an MCP server Escro does not run. This module carries no relative import, so a
// localnet scenario can load the same composition the bot runs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeTaskSpecHash, jcs } from "@escro/sdk";
import type { EscrowAccount, ServiceAdapter, ServiceResult, TaskSpec } from "@escro/sdk";
import { z } from "zod";

export interface McpCaller {
  /** Every tool the server lists, following `nextCursor` to the last page. */
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function connectMcp(serverUrl: string): Promise<McpCaller> {
  const client = new Client({ name: "escro-mcp-worker", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));
  return {
    listTools: async () => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    callTool: async (name, args, timeoutMs) =>
      (await client.callTool({ name, arguments: args }, undefined, {
        timeout: timeoutMs,
      })) as CallToolResult,
    close: () => client.close(),
  };
}

const JOB_WORDS = /\b(generate|render|create|build|train|convert|transcode|export|job|task)\b/i;

/** The tools a buyer can hire: long-running work the client can call. */
export function eligibleTools(tools: Tool[]): {
  eligible: Tool[];
  excluded: { name: string; reason: string }[];
} {
  const eligible: Tool[] = [];
  const excluded: { name: string; reason: string }[] = [];
  for (const tool of tools) {
    const taskSupport = tool.execution?.taskSupport;
    if (tool.annotations?.readOnlyHint === true) {
      excluded.push({ name: tool.name, reason: "read-only: declares readOnlyHint" });
    } else if (taskSupport === "required") {
      excluded.push({ name: tool.name, reason: "requires the task API, which this client lacks" });
    } else if (
      tool.outputSchema !== undefined ||
      taskSupport === "optional" ||
      JOB_WORDS.test(`${tool.name} ${tool.description ?? ""}`)
    ) {
      eligible.push(tool);
    } else {
      excluded.push({
        name: tool.name,
        reason: "no job signal: no outputSchema, optional task support or job-naming word",
      });
    }
  }
  return { eligible, excluded };
}

const ROUTE_SLUG = /^[a-z0-9_-]{1,64}$/;

/** The 402 route for a tool. An MCP tool name is not always a valid route, so this can throw. */
export function routeSlug(tool: string): string {
  const slug = tool.toLowerCase().replaceAll(".", "-");
  if (!ROUTE_SLUG.test(slug)) {
    throw new Error(
      `The tool "${tool}" has no valid route: "${slug}" fails ${String(ROUTE_SLUG)}.`,
    );
  }
  return slug;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The MCP server is the full validator: generated code takes no JSON Schema validator dependency.
function assertArguments(tool: Tool, args: unknown): asserts args is Record<string, unknown> {
  if (!isPlainObject(args)) {
    throw new Error(`The arguments for ${tool.name} must be a JSON object.`);
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in args)) throw new Error(`The arguments for ${tool.name} are missing "${key}".`);
  }
  if (tool.inputSchema.additionalProperties === false) {
    const known = Object.keys(tool.inputSchema.properties ?? {});
    for (const key of Object.keys(args)) {
      if (!known.includes(key)) {
        throw new Error(`The arguments for ${tool.name} carry an unknown key "${key}".`);
      }
    }
  }
}

/** The job a request describes. Deterministic: the paid request re-derives it and must match the 402's hash. */
export function taskSpecForTool(serverUrl: string, tool: Tool, args: unknown): TaskSpec {
  assertArguments(tool, args);
  const server = new URL(serverUrl).hostname;
  return {
    version: "1.0.0",
    taskType: "custom",
    description: `Run the MCP tool ${tool.name} on ${server} with the arguments in metadata.`,
    acceptanceCriteria: [{ id: "ac-1", description: "the tool returned a result" }],
    deliverableFormat:
      tool.outputSchema !== undefined
        ? { type: "json", schema: tool.outputSchema }
        : { type: "file" },
    metadata: { mcp: { server, tool: tool.name, inputSchema: tool.inputSchema, arguments: args } },
  };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

type Block = CallToolResult["content"][number];

function blockBytes(block: Exclude<Block, { type: "resource_link" }>): Buffer {
  if (block.type === "text") return Buffer.from(block.text, "utf8");
  if (block.type === "resource") {
    return "blob" in block.resource
      ? Buffer.from(block.resource.blob, "base64")
      : Buffer.from(block.resource.text, "utf8");
  }
  return Buffer.from(block.data, "base64");
}

function manifestPart(block: Block, index: number): Record<string, unknown> {
  if (block.type === "resource_link") {
    return {
      index,
      type: block.type,
      ...(block.mimeType !== undefined && { mimeType: block.mimeType }),
      uri: block.uri,
      // resources/read is out of scope, so this pins the link and not the content it names.
      sha256: sha256(Buffer.from(block.uri, "utf8")),
    };
  }
  const bytes = blockBytes(block);
  const mimeType = block.type === "resource" ? block.resource.mimeType : undefined;
  const declared = block.type === "image" || block.type === "audio" ? block.mimeType : mimeType;
  return {
    index,
    type: block.type,
    ...(declared !== undefined && { mimeType: declared }),
    ...(block.type === "resource" && { uri: block.resource.uri }),
    sha256: sha256(bytes),
    base64: bytes.toString("base64"),
  };
}

function resultOf(content: string | Buffer): ServiceResult {
  return { content, contentHash: sha256(content), metadata: {} };
}

/** The deliverable and its hash, in a form a buyer can recompute. An error is never a deliverable. */
export function hashToolResult(result: CallToolResult): ServiceResult {
  if (result.isError === true) {
    throw new Error("The tool returned an error result.");
  }
  if (result.structuredContent !== undefined) return resultOf(jcs(result.structuredContent));
  const only = result.content.at(0);
  if (only === undefined) throw new Error("The tool returned nothing to deliver.");
  if (result.content.length === 1 && only.type !== "resource_link") {
    const bytes = blockBytes(only);
    if (bytes.length === 0) throw new Error("The tool returned nothing to deliver.");
    return resultOf(only.type === "text" ? only.text : bytes);
  }
  return resultOf(jcs({ kind: "escro.mcp.manifest/1", parts: result.content.map(manifestPart) }));
}

const MAX_FAILED_CALLS = 3;
const MAX_TRACKED_ESCROWS = 64;

const McpMetadataSchema = z.object({
  mcp: z.object({ tool: z.string(), arguments: z.record(z.unknown()) }),
});

export interface McpAdapter extends ServiceAdapter {
  /** `execute` with one call per escrow per process and a failure budget per escrow. */
  executeFor(escrow: string, spec: TaskSpec): Promise<ServiceResult>;
}

export function createMcpAdapter(deps: {
  serverUrl: string;
  tools: Tool[];
  connect: () => Promise<McpCaller>;
  timeoutMs: number;
}): McpAdapter {
  const { tools, connect, timeoutMs } = deps;
  const calls = new Map<string, Promise<ServiceResult>>();
  const failures = new Map<string, number>();
  const inFlight = new Set<string>();

  function trim(map: Map<string, unknown>): void {
    for (const key of map.keys()) {
      if (map.size <= MAX_TRACKED_ESCROWS) return;
      if (!inFlight.has(key)) map.delete(key);
    }
  }

  // A new session per attempt: a session can expire between hires and the SDK does not renew one.
  async function attempt(spec: TaskSpec, onCall: () => void): Promise<ServiceResult> {
    const parsed = McpMetadataSchema.safeParse(spec.metadata);
    if (!parsed.success) throw new Error("The spec carries no MCP tool call in its metadata.");
    const { tool: name, arguments: args } = parsed.data.mcp;
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`The spec names the tool "${name}", which this worker does not sell.`);
    }
    const caller = await connect();
    let result: CallToolResult;
    try {
      await caller.listTools();
      onCall();
      result = await caller.callTool(name, args, timeoutMs);
    } finally {
      // The call is already paid for: a session that will not close must not cost a second one.
      await caller.close().catch(() => undefined);
    }
    return hashToolResult(result);
  }

  return {
    id: "mcp",
    capabilities: tools.map((tool) => tool.name),
    execute: (spec) => attempt(spec, () => undefined),
    healthCheck: async () => {
      try {
        const caller = await connect();
        await caller.close();
        return true;
      } catch {
        return false;
      }
    },
    executeFor: (escrow, spec) => {
      const held = calls.get(escrow);
      if (held !== undefined) return held;
      if ((failures.get(escrow) ?? 0) >= MAX_FAILED_CALLS) {
        return Promise.reject(
          new Error(
            `${escrow}: the tool failed ${String(MAX_FAILED_CALLS)} times; not calling it again.`,
          ),
        );
      }
      let called = false;
      const running = attempt(spec, () => {
        called = true;
      });
      calls.set(escrow, running);
      inFlight.add(escrow);
      void running.then(
        () => {
          inFlight.delete(escrow);
          trim(calls);
        },
        () => {
          inFlight.delete(escrow);
          calls.delete(escrow);
          if (called) {
            const count = (failures.get(escrow) ?? 0) + 1;
            failures.delete(escrow);
            failures.set(escrow, count);
            trim(failures);
          }
        },
      );
      return running;
    },
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Content-addressed specs. A value read from the API never becomes a path unless it is a hash. */
export function createSpecStore(dir: string): {
  put(spec: TaskSpec): string;
  get(hash: string): TaskSpec | undefined;
} {
  return {
    put: (spec) => {
      const hash = computeTaskSpecHash(spec);
      const file = join(dir, `${hash}.json`);
      if (existsSync(file)) return hash;
      mkdirSync(dir, { recursive: true });
      const temporary = `${file}.${String(process.pid)}.tmp`;
      writeFileSync(temporary, JSON.stringify(spec));
      renameSync(temporary, file);
      return hash;
    },
    get: (hash) => {
      if (!SHA256_HEX.test(hash)) return undefined;
      const file = join(dir, `${hash}.json`);
      if (!existsSync(file)) return undefined;
      const spec = JSON.parse(readFileSync(file, "utf8")) as TaskSpec;
      if (computeTaskSpecHash(spec) !== hash) {
        throw new Error(`The stored spec ${hash} does not hash to its name.`);
      }
      return spec;
    },
  };
}

// Declared here, structurally, so this module imports nothing from the worker template.
export interface McpHostConfig {
  network: "devnet" | "mainnet";
  estimatedServiceCostUsdc: number;
  estimatedDurationSeconds: number;
  serve402: {
    enabled: boolean;
    host: string;
    port: number;
    publicUrl?: string | undefined;
    routes: { capability: string; priceUsdc: number }[];
  };
}

const PriceSchema = z.object({
  costUsdc: z.number().finite().nonnegative(),
  marginUsdc: z.number().finite().nonnegative(),
});

const ManifestSchema = z.object({
  server: z.string().url(),
  network: z.enum(["devnet", "mainnet"]),
  tools: z.array(z.string()),
  publicUrl: z.string().nullable(),
  pricing: z.record(PriceSchema),
});

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

export async function loadMcpService<C extends McpHostConfig>(input: {
  projectRoot: string;
  manifest: unknown;
  config: C;
  parseConfig: (raw: unknown) => C;
  usdcToMicro: (usdc: number) => number;
  connect: (serverUrl: string) => Promise<McpCaller>;
  logger: { warn(message: string): void };
}): Promise<
  | { idle: string }
  | {
      config: C;
      adapter: McpAdapter;
      resolveTaskSpec: (t: EscrowAccount) => Promise<TaskSpec>;
      claimRefusal: (t: EscrowAccount) => Promise<string | null>;
      taskSpecFor: (capability: string, body: unknown) => TaskSpec;
      executeJob: (escrow: string, spec: TaskSpec) => Promise<ServiceResult>;
    }
> {
  const { projectRoot, config, parseConfig, usdcToMicro, connect, logger } = input;
  const parsed = ManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    return { idle: `escro.mcp.json is not valid (${issuesOf(parsed.error)}): fix it.` };
  }
  const manifest = parsed.data;
  if (manifest.network !== config.network) {
    return {
      idle:
        `The network in escro.mcp.json (${manifest.network}) differs from escro.config.ts's ` +
        `(${config.network}): make them match.`,
    };
  }
  if (manifest.tools.length === 0) {
    return {
      idle: "No tools are confirmed: run npm run mcp:tools and add the ones to sell to tools in escro.mcp.json.",
    };
  }

  const pricing = new Map(Object.entries(manifest.pricing));
  const prices = new Map<string, z.infer<typeof PriceSchema>>();
  const toolBySlug = new Map<string, string>();
  for (const name of manifest.tools) {
    const price = pricing.get(name);
    if (price === undefined) {
      return {
        idle: `The tool ${name} has no price: set its costUsdc and marginUsdc under pricing in escro.mcp.json.`,
      };
    }
    prices.set(name, price);
    let slug: string;
    try {
      slug = routeSlug(name);
    } catch (err) {
      return {
        idle: `${err instanceof Error ? err.message : String(err)} Remove it from tools in escro.mcp.json.`,
      };
    }
    const other = toolBySlug.get(slug);
    if (other !== undefined) {
      return {
        idle: `The tools ${other} and ${name} both route to ${slug}: keep one in escro.mcp.json.`,
      };
    }
    toolBySlug.set(slug, name);
  }
  if (manifest.publicUrl === null) {
    return {
      idle: "Set publicUrl in escro.mcp.json to the https origin buyers reach this bot on.",
    };
  }

  const lister = await connect(manifest.server);
  let listed: Tool[];
  try {
    listed = await lister.listTools();
  } finally {
    await lister.close();
  }
  const { eligible, excluded } = eligibleTools(listed);
  const sold = new Map<string, Tool>();
  for (const name of manifest.tools) {
    const tool = eligible.find((t) => t.name === name);
    if (tool === undefined) {
      const why = excluded.find((e) => e.name === name)?.reason ?? "the server does not list it";
      return {
        idle: `The tool ${name} cannot be sold (${why}): remove it from tools in escro.mcp.json.`,
      };
    }
    sold.set(name, tool);
  }

  const priceMicro = new Map<string, number>();
  let largestCostMicro = 0;
  for (const [name, price] of prices) {
    const cost = usdcToMicro(price.costUsdc);
    priceMicro.set(name, cost + usdcToMicro(price.marginUsdc));
    largestCostMicro = Math.max(largestCostMicro, cost);
  }

  let effective: C;
  try {
    effective = parseConfig({
      ...config,
      estimatedServiceCostUsdc: largestCostMicro / 1_000_000,
      serve402: {
        ...config.serve402,
        enabled: true,
        publicUrl: manifest.publicUrl,
        routes: [...toolBySlug].map(([capability, name]) => ({
          capability,
          priceUsdc: (priceMicro.get(name) ?? 0) / 1_000_000,
        })),
      },
    });
  } catch (err) {
    const why =
      err instanceof z.ZodError ? issuesOf(err) : err instanceof Error ? err.message : String(err);
    return { idle: `The price or publicUrl in escro.mcp.json is refused (${why}): fix it.` };
  }

  const adapter = createMcpAdapter({
    serverUrl: manifest.server,
    tools: [...sold.values()],
    connect: () => connect(manifest.server),
    timeoutMs: config.estimatedDurationSeconds * 1000,
  });
  const store = createSpecStore(join(projectRoot, ".escro", "mcp-specs"));

  return {
    config: effective,
    adapter,
    resolveTaskSpec: async (task) => {
      await Promise.resolve();
      const spec = store.get(task.taskSpecHash);
      if (spec === undefined) throw new Error(`No spec on file for ${task.taskSpecHash}.`);
      return spec;
    },
    claimRefusal: async (task) => {
      await Promise.resolve();
      const spec = store.get(task.taskSpecHash);
      if (spec === undefined) return "no spec on file for its hash";
      const name = McpMetadataSchema.safeParse(spec.metadata).data?.mcp.tool;
      const price = name === undefined ? undefined : priceMicro.get(name);
      if (price === undefined) return "its spec names a tool not on sale";
      return task.amount < BigInt(price) ? "the escrow is under the tool's price" : null;
    },
    // Pure: the menu runs this on unpaid requests, which must never reach the disk.
    taskSpecFor: (capability, body) => {
      const name = toolBySlug.get(capability);
      const tool = name === undefined ? undefined : sold.get(name);
      if (tool === undefined) throw new Error(`No tool is sold on the route ${capability}.`);
      return taskSpecForTool(manifest.server, tool, body);
    },
    executeJob: (escrow, spec) => {
      try {
        store.put(spec);
      } catch (err) {
        // The process still holds the spec for this run; only a restart would lose it.
        logger.warn(
          `[worker] ${escrow}: the spec was not saved: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return adapter.executeFor(escrow, spec);
    },
  };
}
