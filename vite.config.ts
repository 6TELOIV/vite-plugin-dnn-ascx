import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "VitePluginDnnAscx",
      formats: ["es", "cjs"],
      fileName: (format) => (format === "es" ? "index.mjs" : "index.cjs"),
    },
    rollupOptions: {
      // These should NOT be bundled (they’re node/vite runtime deps)
      external: ["vite", "rollup", "node:fs", "node:path", "fast-glob"],
    },
  },
});
