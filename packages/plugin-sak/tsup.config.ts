import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  tsconfig: "tsconfig.build.json",
  dts: true,
  // @escro/shared is private, so its cluster URL helpers are inlined. @escro/sdk stays external because its spend-cap
  // ledgers are per module, and zod because the kit tests schemas with instanceof ZodObject against its own copy.
  noExternal: ["@escro/shared"],
  external: ["@escro/sdk", "zod"],
  // The inlined tweetnacl requires Node's crypto at load, and esbuild's ESM require shim throws without a real require.
  banner: ({ format }) =>
    format === "esm"
      ? {
          js: 'import { createRequire as __escroCreateRequire } from "node:module"; const require = __escroCreateRequire(import.meta.url);',
        }
      : {},
  target: "es2020",
  sourcemap: true,
  clean: true,
});
