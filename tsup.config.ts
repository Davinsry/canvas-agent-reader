import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "bin/cli": "src/cli/bin.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  // No global banner: src/cli/bin.ts carries its own shebang, and prepending a second one
  // made dist/bin/cli.js invalid JS (and put a stray shebang on the library entry too).
});