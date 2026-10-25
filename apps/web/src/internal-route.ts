import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Rejects requests to /internal paths with 404 so Vite never serves the single-page application
 * shell (index.html) for operator-only or internal endpoints.
 */
export function internalRouteMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split("?", 1)[0] ?? "/";
    if (pathname === "/internal" || pathname.startsWith("/internal/")) {
      res.statusCode = 404;
      res.setHeader("cache-control", "no-store");
      res.end("Not found");
      return;
    }
    next();
  };
}
