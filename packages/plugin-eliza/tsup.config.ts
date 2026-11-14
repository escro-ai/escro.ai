import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: {
    resolve: ["@escro/shared"],
    compilerOptions: { composite: false, incremental: false },
  },
  // @escro/shared is a private workspace package; inline the runtime values we
  // use (e.g. MIN_ESCROW_AMOUNT) so the published bundle is self-contained.
  // @escro/sdk stays external — it is a real, published runtime dependency.
  noExternal: ["@escro/shared"],
  // tweetnacl, inlined through the bundle, calls require("crypto") at load, which an ES module lacks.
  banner: ({ format }) =>
    format === "esm"
      ? {
          js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
        }
      : {},
  target: "es2020",
  sourcemap: true,
  clean: true,
});
