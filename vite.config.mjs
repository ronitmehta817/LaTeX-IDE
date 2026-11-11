import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import worker from "./worker/index.js";

// NVIDIA's API sends no CORS headers, so browsers can only reach it through the app's own origin.
const proxy = {
  "/proxy/nvidia": {
    target: "https://integrate.api.nvidia.com",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/proxy\/nvidia/, ""),
  },
};

// Runs the Cloudflare Worker's /auth and /log routes inside the dev and preview
// servers, with its settings read from .env.local.
function googleAuth() {
  let env = {};
  const handle = async (req, res, next) => {
    if (!req.url?.startsWith("/auth/") && !req.url?.startsWith("/log/")) return next();
    try {
      const headers = new Headers();
      for (const name of ["cookie", "origin", "content-type"]) {
        if (req.headers[name]) headers.set(name, req.headers[name]);
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await worker.fetch(
        new Request(new URL(req.url, `http://${req.headers.host}`), {
          method: req.method,
          headers,
          body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        }),
        env,
      );
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") res.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  };
  return {
    name: "google-auth",
    configResolved(config) {
      const values = loadEnv(config.mode, config.envDir || config.root, "");
      env = {
        GOOGLE_CLIENT_ID: values.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: values.GOOGLE_CLIENT_SECRET,
        SESSION_SECRET: values.SESSION_SECRET,
      };
    },
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

// Cloudflare serves public/privacy.html at /privacy; Vite only serves it with the .html.
function privacyPage() {
  const rewrite = (req, _res, next) => {
    if (/^\/privacy\/?(\?|$)/.test(req.url ?? "")) {
      req.url = req.url.replace(/^\/privacy\/?/, "/privacy.html");
    }
    next();
  };
  return {
    name: "privacy-page",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  plugins: [react(), googleAuth(), privacyPage()],
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
    proxy,
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
    proxy,
  },
});
