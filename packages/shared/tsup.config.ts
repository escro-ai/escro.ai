import { defineConfig, type Options } from "tsup";

const common: Options = {
  format: ["esm", "cjs"],
  dts: { compilerOptions: { composite: false, incremental: false } },
  sourcemap: true,
  shims: false,
};

// `./chain` builds on its own, so the other entries' outputs carry none of its modules: no JS or
// declaration chunk is shared with the entries it imports from.
// The two builds run at once, so neither cleans `dist`; the build script empties it first.
export default defineConfig([
  { ...common, entry: ["src/index.ts", "src/solana.ts"], clean: false },
  { ...common, entry: ["src/chain.ts"], clean: false },
]);
