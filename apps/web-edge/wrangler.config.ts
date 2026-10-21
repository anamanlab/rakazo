import { defineWranglerConfig } from "wrangler/experimental-config";

/**
 * Tooling-side build settings. The runtime asset settings live in
 * `cloudflare.config.ts` under `worker.assets`.
 *
 * The asset directory is the SPA that `apps/web` builds. It is built by the web app's
 * own Vite build, not here, so the desktop bundle and this edge bundle stay the same
 * artifact.
 */
export default defineWranglerConfig({
  assetsDirectory: "../web/dist",
  uploadSourceMaps: true,
});
