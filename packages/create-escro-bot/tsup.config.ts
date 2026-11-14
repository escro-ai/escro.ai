import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  noExternal: ["@escro/shared"],
  sourcemap: true,
  clean: true,
  dts: false,
});
