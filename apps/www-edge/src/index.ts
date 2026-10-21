/**
 * Edge entry point for the marketing site.
 *
 * The site itself is a static Astro build. This Worker adds what a static build
 * cannot: content negotiation, so a request that accepts Markdown gets the Markdown
 * representation, and the download route, which redirects to the newest installer
 * without a rebuild.
 */
import {
  getMarkdownAlternate,
  getMarkdownDocument,
  markdownResponse,
  negotiateRepresentation,
} from "@rakazo/www/agent-content";
import { fetchDownload } from "./download.ts";

/**
 * The static asset binding. Spelled out here so the site keeps the DOM library it
 * shares with Astro and does not need the Workers type package.
 */
interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ASSETS: AssetFetcher;
}

const VARY_HEADER = "Accept, Accept-Encoding";
const APEX_ORIGIN = "https://rakazo.com";
const WWW_HOST = "www.rakazo.com";

/**
 * The paths the static site owns. A request for a file with an extension or a build
 * asset is left alone.
 */
function isSitePath(pathname: string): boolean {
  if (pathname === "/_astro" || pathname.startsWith("/_astro/")) return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "vary") {
      const current = merged.get("vary");
      merged.set(
        "vary",
        current && !current.includes(value) ? `${current}, ${value}` : (current ?? value),
      );
      continue;
    }
    merged.set(name, value);
  }
  // A bodyless status cannot carry a body.
  const body = response.status === 204 || response.status === 304 ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/download") return fetchDownload(request);

    if (url.hostname.toLowerCase() === WWW_HOST) {
      const destination = new URL(`${url.pathname}${url.search}`, APEX_ORIGIN);
      return new Response(null, { status: 301, headers: { Location: destination.toString() } });
    }

    if (url.pathname === "/sitemap.xml") {
      return new Response(null, { status: 301, headers: { Location: "/sitemap-index.xml" } });
    }

    if (!isSitePath(url.pathname)) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);

    const representation = negotiateRepresentation(request.headers.get("accept"));
    const markdown = getMarkdownDocument(url.pathname);

    if (representation === "markdown" && markdown) {
      return markdownResponse(markdown, request.method);
    }

    if (representation === "not-acceptable") {
      return new Response(
        request.method === "HEAD" ? null : "Not acceptable. Request text/html or text/markdown.\n",
        {
          status: 406,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Vary: VARY_HEADER,
          },
        },
      );
    }

    const markdownAlternate = getMarkdownAlternate(url.pathname);
    return withHeaders(await env.ASSETS.fetch(request), {
      ...(markdownAlternate
        ? { Link: `<${markdownAlternate}>; rel="alternate"; type="text/markdown"` }
        : {}),
      Vary: VARY_HEADER,
    });
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> };
