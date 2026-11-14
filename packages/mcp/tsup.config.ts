import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/tools.ts",
    "src/env.ts",
  ],
  format: ["cjs"],
  noExternal: ["@escro/sdk", "@escro/shared"],
  target: "node22",
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
