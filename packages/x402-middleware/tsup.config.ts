import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/express.ts", "src/fastify.ts"],
  format: ["esm", "cjs"],
  tsconfig: "tsconfig.build.json",
  dts: true,
  target: "es2022",
  sourcemap: true,
  clean: true,
});
