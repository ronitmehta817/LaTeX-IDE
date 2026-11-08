import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "blake3-wasm/browser.js": fileURLToPath(
        new URL("./src/blake3-disabled.js", import.meta.url),
      ),
    },
    dedupe: ["@siglum/filesystem"],
  },
  build: {
    target: "esnext",
  },
  define: {
    global: "globalThis",
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});
