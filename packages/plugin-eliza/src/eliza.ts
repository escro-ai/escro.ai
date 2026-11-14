/**
 * Minimal vendored type surface for `@elizaos/core`.
 *
 * `@elizaos/core` (v1.7.x or v2.x) is provided by the host elizaOS runtime at load time;
 * this plugin imports ZERO runtime values from it. It is intentionally NOT declared
 * as a dependency or peerDependency here: this monorepo runs pnpm with
 * auto-install-peers enabled (a root-level setting this package cannot scope), so a
 * declared peer is materialized into the workspace - dragging core's heavy runtime
 * tree (langchain, pdfjs-dist, handlebars, and a zod v4 that clashes with this
 * repo's zod v3) in for types that are erased at build time. Instead we vendor the
 * narrow subset of core's public interfaces that `commission_task` implements
 * against. Ideal end state (owner: root workspace, not this lane): re-add the
 * peerDependency once `pnpm.peerDependencyRules.ignoreMissing` lists it.
 *
 * Every interface below is a faithful, structurally-typed SUBSET copied from the
 * published declarations of:
 *
 *   @elizaos/core@1.7.2  dist/types/{primitives,components,plugin,runtime}.d.ts
 *   (fetched from the npm registry 2026-08-10)
 *
 * and each is kept wide or narrow enough that one build assigns to the `Plugin` of both core
 * lines, checked against the published 1.7.2 and 2.0.5 declarations: a type the host hands in
 * (`Memory`, `IAgentRuntime`, `State`) accepts either line's, and a type the plugin hands out
 * (`ResponseContent`, `ActionExample`, `ActionResult`) fits either line's, so it takes 2.x's
 * narrower index and record values.
 *
 * These are CONSUME-only views (the plugin receives an `IAgentRuntime`/`Memory`
 * from the host; it never constructs or fully implements them). A view of a value the
 * host passes in carries an index signature only where core's declaration does
 * (`Content`, `State`): a core interface without one does not assign to a view that
 * has one. Beyond the out-going types above, the only intentional narrowing is
 * `Handler`'s return type (`Promise<ActionResult>` - this plugin always returns a
 * result), which stays assignable to 1.x's wider `Promise<ActionResult | void |
 * undefined>`. If a future `@elizaos/core` major changes these shapes, re-verify
 * against the published `.d.ts` and update this file.
 */

/**
 * @elizaos/core dist/types/primitives.d.ts - `UUID`: a five-part template literal in 1.x, `string`
 * in 2.x. Every UUID here is one the host hands in, so the view takes the wider 2.x type.
 */
export type UUID = string;

/** @elizaos/core 2.x dist/types/json.d.ts - `JsonValue`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * @elizaos/core 2.x dist/types/components.d.ts - `ProviderValue`, what 2.x's `ActionResult.values`
 * and `.data` hold (1.x's hold `unknown`).
 */
export type ProviderValue = JsonValue | Uint8Array | bigint | object | undefined;

/**
 * @elizaos/core dist/types/primitives.d.ts - `Content` (subset), as the host hands it in
 * (`Memory.content`): 1.x's index signature holds `unknown`, so this one does too.
 */
export interface Content {
  /** The agent's internal thought process. */
  thought?: string;
  /** The main text content visible to users. */
  text?: string;
  /** Actions to be performed. */
  actions?: string[];
  /** Source/origin of the content. */
  source?: string;
  /** Additional dynamic properties (core's own extension point). */
  [key: string]: unknown;
}

/**
 * @elizaos/core dist/types/primitives.d.ts - `Content` (subset), as the plugin hands it out (a
 * reply through `HandlerCallback`, an `ActionExample`): 2.x's index signature holds JSON-like
 * values only, so this one does too; it stays assignable to `Content`.
 */
export interface ResponseContent {
  /** The agent's internal thought process. */
  thought?: string;
  /** The main text content visible to users. */
  text?: string;
  /** Actions to be performed. */
  actions?: string[];
  /** Source/origin of the content. */
  source?: string;
  /** Additional dynamic properties, JSON-like in 2.x. */
  [key: string]: JsonValue | undefined;
}

/**
 * @elizaos/core dist/types/memory.d.ts - `Memory` (subset). The plugin reads `id` and `content`;
 * `entityId` is typed for an operator's `authorizeChatInput` and read by the plugin nowhere.
 */
export interface Memory {
  id?: UUID;
  entityId?: UUID;
  content: Content;
}

/** @elizaos/core dist/types/state.d.ts - `State` (subset). */
export interface State {
  values: Record<string, unknown>;
  data: Record<string, unknown>;
  text: string;
  [key: string]: unknown;
}

/** @elizaos/core dist/types/components.d.ts - `ActionResult` (subset). */
export interface ActionResult {
  /** Whether the action succeeded. */
  success: boolean;
  /** Human-readable description of the result. */
  text?: string;
  /** Values to merge into the runtime state. */
  values?: Record<string, ProviderValue>;
  /** Action-specific result payload. */
  data?: Record<string, ProviderValue>;
  /** Error information if the action failed. */
  error?: string | Error;
}

/** @elizaos/core dist/types/components.d.ts - `ActionExample`. */
export interface ActionExample {
  /** Name of the participant (user or agent). */
  name: string;
  /** Message content. */
  content: ResponseContent;
}

/** @elizaos/core dist/types/components.d.ts - `HandlerCallback`. */
export type HandlerCallback = (response: ResponseContent) => Promise<Memory[]>;

/**
 * @elizaos/core dist/types/components.d.ts - `HandlerOptions` (subset).
 * The plugin does not read multi-step plan context, so this is left opaque.
 */
export type HandlerOptions = Record<string, unknown>;

/**
 * Minimal logger surface exposed by `IAgentRuntime.logger`
 * (@elizaos/core dist/logger - Logger). The plugin uses only these levels.
 * Method signatures, not function-typed properties: core's `LogFn` takes a narrower first
 * parameter, and only a method is compared bivariantly under `strictFunctionTypes`, so a
 * plugin typed against this view still assigns to core's `Plugin`.
 */
export interface ElizaLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * @elizaos/core dist/types/runtime.d.ts - `IAgentRuntime` (consume-only subset).
 * The real interface extends `IDatabaseAdapter` and is large; this plugin reads
 * ONLY `getSetting` (and optionally `logger`). No index signature: core declares
 * none, so a real runtime is assignable to this view only without one.
 */
export interface IAgentRuntime {
  /** Wider than the core declaration: a runtime may answer `undefined` for an unset key. */
  getSetting(key: string): string | boolean | number | null | undefined;
  logger?: ElizaLogger;
  agentId?: UUID;
}

/** @elizaos/core dist/types/components.d.ts - `Validator`. */
export type Validator = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
) => Promise<boolean>;

/**
 * @elizaos/core dist/types/components.d.ts - `Handler`.
 * Return narrowed to `Promise<ActionResult>` (this plugin always returns a
 * result); assignable to core's `Promise<ActionResult | void | undefined>`.
 */
export type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
  responses?: Memory[],
) => Promise<ActionResult>;

/** @elizaos/core dist/types/components.d.ts - `Action` (subset). */
export interface Action {
  name: string;
  description: string;
  similes?: string[];
  examples?: ActionExample[][];
  validate: Validator;
  handler: Handler;
  [key: string]: unknown;
}

/** @elizaos/core dist/types/plugin.d.ts - `Plugin` (subset). */
export interface Plugin {
  name: string;
  description: string;
  actions?: Action[];
  [key: string]: unknown;
}
