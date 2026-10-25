import { bindings, defineConfig, triggers } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * The hostnames this edge serves. They are configuration rather than constants so
 * the same bundle can answer for a preview host and for production, and so the
 * repository does not name the deployment.
 */
const host = process.env.RAKAZO_EDGE_HOST ?? "app.example.com";
const zone = process.env.RAKAZO_EDGE_ZONE ?? "example.com";
const origin = process.env.RAKAZO_EDGE_ORIGIN ?? "https://origin.example.com";
const gitSha = process.env.RAKAZO_GIT_SHA ?? process.env.GITHUB_SHA ?? "";

/**
 * The app is same-origin by construction: it builds every API URL from
 * `window.location`, so the document and the API must answer on one hostname. The
 * document is served from the edge; the API is a Node server behind a Cloudflare
 * Tunnel, so the paths the app calls are proxied back to it.
 *
 * The origin is a binding rather than a literal so the same build can be pointed at a
 * preview origin without editing the source.
 */
export default defineConfig({
  worker: {
    name: "rakazo-web",
    entrypoint,
    compatibilityDate: "2026-10-21",
    workersDev: false,
    previewUrls: false,
    triggers: [triggers.fetch({ pattern: `${host}/*`, zone })],
    // The API paths go to the Worker; every other request is answered by the asset
    // worker straight from the edge, where static asset requests are free.
    assets: {
      htmlHandling: "none",
      notFoundHandling: "single-page-application",
      runWorkerFirst: [
        "/api",
        "/api/*",
        "/rpc",
        "/rpc/*",
        "/mcp/*",
        "/.well-known/*",
        "/novnc/*",
        "/health",
        "/ready",
        "/internal",
        "/internal/*",
      ],
    },
    env: {
      ASSETS: bindings.assets(),
      ORIGIN: bindings.text(origin),
      ...(gitSha ? { GIT_SHA: bindings.text(gitSha) } : {}),
    },
    observability: {
      enabled: true,
      // Tokens and screen capabilities travel in query strings; keep them out of logs.
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: false },
    },
  },
});
