import { bindings, defineConfig, triggers } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * The hostnames this edge serves. They are configuration rather than constants so
 * the same bundle can answer for a preview host and for production, and so the
 * repository does not name the deployment.
 */
const host = process.env.RAKAZO_WWW_EDGE_HOST ?? "www.example.com";
const zone = process.env.RAKAZO_EDGE_ZONE ?? "example.com";

/**
 * The marketing site is a static Astro build served from the edge. The Worker adds
 * the content negotiation and the download route, so it answers every request before
 * the assets do.
 */
export default defineConfig({
  worker: {
    name: "rakazo-www",
    entrypoint,
    compatibilityDate: "2026-10-21",
    workersDev: false,
    previewUrls: false,
    triggers: [triggers.fetch({ pattern: `${host}/*`, zone })],
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: true,
    },
    env: {
      ASSETS: bindings.assets(),
    },
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: false },
    },
  },
});
