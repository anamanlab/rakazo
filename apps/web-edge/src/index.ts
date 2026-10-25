/**
 * Edge entry point for the Rakazo web app.
 *
 * The SPA is a static bundle served from the edge. The API is a Node server that
 * lives behind a Cloudflare Tunnel, so the paths the app calls are proxied back to it
 * on the same hostname the document was served from: the app builds every API URL
 * from `window.location`, so the API has to answer on the app's own origin.
 */

export interface Env {
  /** The static SPA bundle. */
  ASSETS: Fetcher;
  /** The origin that serves the API, reached through the tunnel. */
  ORIGIN: string;
  /** The git commit SHA of this build. */
  GIT_SHA?: string;
}

/**
 * Paths that belong to the API rather than the document. These are the only ones the
 * Worker forwards; everything else is answered by the asset worker at the edge.
 */
const PROXIED_PREFIXES = ["/api", "/rpc", "/mcp", "/.well-known", "/novnc", "/health", "/ready"];

function isProxied(pathname: string): boolean {
  return PROXIED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal" || url.pathname.startsWith("/internal/")) {
      return new Response("Not Found", { status: 404 });
    }
    if (!isProxied(url.pathname)) return env.ASSETS.fetch(request);
    return proxyToOrigin(request, env.ORIGIN);
  },
} satisfies ExportedHandler<Env>;

async function proxyToOrigin(request: Request, origin: string): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);
  const headers = new Headers(request.headers);

  // Cloudflare puts the caller in CF-Connecting-IP. The API resolves the caller from
  // the forwarded chain, so send that one address and let the hops closer to the API
  // append themselves; a caller cannot put an address there.
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  // Hop-by-hop and edge headers describe this hop, not the one being forwarded to.
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("cf-worker");
  headers.delete("cdn-loop");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    // A redirect from the API is part of its answer, not a step for the browser to
    // follow on the API's behalf.
    redirect: "manual",
  });

  // The screen proxy speaks WebSocket. Hand the socket to the browser unchanged.
  if (upstream.webSocket) {
    return new Response(null, { status: 101, webSocket: upstream.webSocket });
  }

  const responseHeaders = new Headers(upstream.headers);
  // The body streams, so the length the origin declared does not necessarily describe
  // what is sent.
  responseHeaders.delete("content-length");
  // A folded Set-Cookie loses every cookie but the last one; sign-in sets more than one.
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    responseHeaders.delete("set-cookie");
    for (const cookie of setCookies) responseHeaders.append("set-cookie", cookie);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
