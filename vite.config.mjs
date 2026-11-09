import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// NVIDIA's API sends no CORS headers, so browsers can only reach it through the app's own origin.
const proxy = {
  "/proxy/nvidia": {
    target: "https://integrate.api.nvidia.com",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/proxy\/nvidia/, ""),
  },
};

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
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    proxy,
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    proxy,
  },
});
