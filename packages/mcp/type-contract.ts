/**
 * Compile-time contract between `packages/mcp/src` and the hand-written public
 * declarations in `packages/mcp/types`, which `package.json` `exports` points
 * consumers at (`@escro/mcp/server`, `@escro/mcp/env`, `@escro/mcp/tools`).
 *
 * Those declarations are NOT generated, so nothing otherwise stops the source
 * and the published types from diverging. A consumer would typecheck green
 * against a stale shape while the bundled implementation differs. This file is
 * checked by `tsconfig.type-contract.json` (run from the package's `typecheck`
 * script) and fails the moment either side moves without the other.
 *
 * Scope: the `server` and `env` entry points, which are the surface
 * a host embedding the server consumes, and the `tools` handler maps. The `tools`
 * schema records stay loose (`Record<string, z.ZodType>`) and are not covered.
 */
import type { McpEnv as DeclaredMcpEnv } from "./types/env.js";
import type { loadEnv as declaredLoadEnv } from "./types/env.js";
import type { buildServer as declaredBuildServer } from "./types/server.js";
import type {
  makeReadHandlers as declaredMakeReadHandlers,
  makeWriteHandlers as declaredMakeWriteHandlers,
} from "./types/tools.js";
import type { makeChainReadHandlers as declaredMakeChainReadHandlers } from "./types/tools.js";
import type { McpEnv } from "./src/env.js";
import type { loadEnv } from "./src/env.js";
import type { buildServer } from "./src/server.js";
import type { makeReadHandlers, makeWriteHandlers } from "./src/tools.js";
import type { makeChainReadHandlers } from "./src/tools.js";

/**
 * True only when A and B are the SAME type. Mutual assignability is too weak
 * here: `(x?: string) => T` and `() => T` are assignable both ways, so an
 * added optional parameter in one side would slip through unnoticed. `probe` only keeps T
 * used twice for the lint; the comparison is the usual deferred-conditional one.
 */
type Identical<A, B> =
  (<T>(probe: T) => T extends A ? 1 : 2) extends <T>(probe: T) => T extends B ? 1 : 2
    ? true
    : false;

// Each assignment fails to compile if the declared and implemented shapes drift.
const envShapeMatches: Identical<McpEnv, DeclaredMcpEnv> = true;
const loadEnvSignatureMatches: Identical<typeof loadEnv, typeof declaredLoadEnv> = true;
const buildServerSignatureMatches: Identical<typeof buildServer, typeof declaredBuildServer> = true;
const writeHandlersMatch: Identical<typeof makeWriteHandlers, typeof declaredMakeWriteHandlers> =
  true;
const chainReadHandlersMatch: Identical<
  typeof makeChainReadHandlers,
  typeof declaredMakeChainReadHandlers
> = true;

// The read handlers differ in one place by construction: src takes EscrowState from
// @escro/shared, the published declarations from @escro/sdk, whose dts inlines its own
// copy of the enum. Two enum declarations are never identical, only mutually assignable
// (same name and members), so list_escrows's `state` is checked by assignability and
// everything else by identity.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// `any` is mutually assignable with everything, so the declared state must not be `any`.
type IsAny<T> = 0 extends 1 & T ? true : false;
type SourceRead = ReturnType<typeof makeReadHandlers>;
type DeclaredRead = ReturnType<typeof declaredMakeReadHandlers>;
type SourceListArgs = Parameters<SourceRead["list_escrows"]>[0];
type DeclaredListArgs = Parameters<DeclaredRead["list_escrows"]>[0];
const readHandlersParamsMatch: Identical<
  Parameters<typeof makeReadHandlers>,
  Parameters<typeof declaredMakeReadHandlers>
> = true;
const readHandlersMatch: Identical<
  Omit<SourceRead, "list_escrows">,
  Omit<DeclaredRead, "list_escrows">
> = true;
const listEscrowsResultMatches: Identical<
  ReturnType<SourceRead["list_escrows"]>,
  ReturnType<DeclaredRead["list_escrows"]>
> = true;
const listEscrowsArgsMatch: Identical<
  Omit<SourceListArgs, "state">,
  Omit<DeclaredListArgs, "state">
> = true;
const listEscrowsStateMatches: MutuallyAssignable<SourceListArgs, DeclaredListArgs> = true;
const listEscrowsStateNotAny: IsAny<DeclaredListArgs["state"]> = false;

export const mcpTypeContract = {
  envShapeMatches,
  loadEnvSignatureMatches,
  buildServerSignatureMatches,
  writeHandlersMatch,
  chainReadHandlersMatch,
  readHandlersParamsMatch,
  readHandlersMatch,
  listEscrowsResultMatches,
  listEscrowsArgsMatch,
  listEscrowsStateMatches,
  listEscrowsStateNotAny,
} as const;
