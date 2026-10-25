import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { internalRouteMiddleware } from "./internal-route.js";

function request(url: string) {
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  internalRouteMiddleware()({ url } as IncomingMessage, res as unknown as ServerResponse, next);
  return { res, next };
}

describe("internal route middleware", () => {
  it("answers 404 for /internal and /internal/health instead of falling through to the SPA", () => {
    const direct = request("/internal");
    expect(direct.next).not.toHaveBeenCalled();
    expect(direct.res.statusCode).toBe(404);
    expect(direct.res.end).toHaveBeenCalledWith("Not found");

    const health = request("/internal/health");
    expect(health.next).not.toHaveBeenCalled();
    expect(health.res.statusCode).toBe(404);
    expect(health.res.end).toHaveBeenCalledWith("Not found");

    const nested = request("/internal/health?query=1");
    expect(nested.next).not.toHaveBeenCalled();
    expect(nested.res.statusCode).toBe(404);
  });

  it("passes ordinary routes and public health/ready to the next middleware", () => {
    expect(request("/").next).toHaveBeenCalled();
    expect(request("/health").next).toHaveBeenCalled();
    expect(request("/ready").next).toHaveBeenCalled();
    expect(request("/chat").next).toHaveBeenCalled();
  });
});
