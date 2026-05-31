import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  publicDir: false,
  build: {
    target: "esnext",
    outDir: "public",
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/game-worker/index.js"),
      output: {
        entryFileNames: "game-worker.js",
        format: "es",
      },
      codeSplitting: false,
    },
  },
  define: {
    global: "globalThis",
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Silence Node.js checks inside BabylonJS
    "process.browser": "true",
  },
  resolve: {
    alias: {
      // Prevent accidental Node.js-only imports in the bundle
      "node:path": resolve(import.meta.dirname, "src/game-worker/noop.js"),
      "node:fs/promises": resolve(import.meta.dirname, "src/game-worker/noop.js"),
      "node:http": resolve(import.meta.dirname, "src/game-worker/noop.js"),
      "node:child_process": resolve(import.meta.dirname, "src/game-worker/noop.js"),
      "xhr2": resolve(import.meta.dirname, "src/game-worker/noop.js"),
    },
  },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
  },
});
