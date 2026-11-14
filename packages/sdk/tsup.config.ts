import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Inline the private, unpublished workspace types (@escro/shared,
  // @escro/reputation) into the SDK's own dts so a published npm consumer gets
  // self-contained types. `resolve` is scoped to those two packages, so
  // genuinely external published deps (e.g. @solana/web3.js) stay external.
  dts: {
    resolve: ["@escro/shared"],
    compilerOptions: {
      composite: false,
      incremental: false,
      // Reached through node_modules, shared's declaration chunks count as external library
      // imports and stay relative imports in this dist, where no such file exists.
      paths: { "@escro/shared": ["../shared/dist/index.d.ts"] },
    },
  },
  noExternal: ["@escro/shared"],
  target: "es2020",
  sourcemap: true,
  clean: true,
});
