import { defineWranglerConfig } from "wrangler/experimental-config";

/**
 * Tooling-side build settings. The runtime asset settings live in
 * `cloudflare.config.ts` under `worker.assets`.
 *
 * The asset directory is the Astro build of the marketing site. It is built by the
 * site's own build, not here, so the site and this edge bundle stay the same
 * artifact.
 */
export default defineWranglerConfig({
  assetsDirectory: "../www/dist",
  uploadSourceMaps: true,
});
