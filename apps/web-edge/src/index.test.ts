import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./index.js";
import worker from "./index.js";

describe("edge worker routing", () => {
  const origin = "https://origin.example.com";
  let assetsFetch: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    assetsFetch = vi.fn(async () => new Response("spa shell", { status: 200 }));
    env = {
      ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
      ORIGIN: origin,
      GIT_SHA: "test-sha-12345",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves static SPA shell for non-proxied paths", async () => {
    const request = new Request("https://app.example.com/");
    const response = await worker.fetch(request as never, env);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("spa shell");
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for /internal and /internal/health instead of serving SPA shell", async () => {
    for (const path of ["/internal", "/internal/health", "/internal/health?query=1"]) {
      const request = new Request(`https://app.example.com${path}`);
      const response = await worker.fetch(request as never, env);
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not Found");
      expect(assetsFetch).not.toHaveBeenCalled();
    }
  });

  it("proxies /ready to origin instead of falling back to SPA assets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, degraded: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const request = new Request("https://app.example.com/ready");
    const response = await worker.fetch(request as never, env);

    expect(assetsFetch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchSpy.mock.calls[0];
    expect(targetUrl.toString()).toBe(`${origin}/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, degraded: false });
  });

  it("proxies /health to origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const request = new Request("https://app.example.com/health");
    const response = await worker.fetch(request as never, env);

    expect(assetsFetch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchSpy.mock.calls[0];
    expect(targetUrl.toString()).toBe(`${origin}/health`);
    expect(response.status).toBe(200);
  });

  it("forwards client IP in x-forwarded-for and strips edge hop headers", async () => {
    let capturedHeaders: Headers | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    });

    const request = new Request("https://app.example.com/ready", {
      headers: {
        "cf-connecting-ip": "198.51.100.42",
        "cf-ipcountry": "US",
        "cf-ray": "123456",
      },
    });
    await worker.fetch(request as never, env);

    expect(capturedHeaders?.get("x-forwarded-for")).toBe("198.51.100.42");
    expect(capturedHeaders?.has("cf-connecting-ip")).toBe(false);
    expect(capturedHeaders?.has("cf-ipcountry")).toBe(false);
    expect(capturedHeaders?.has("cf-ray")).toBe(false);
  });
});
