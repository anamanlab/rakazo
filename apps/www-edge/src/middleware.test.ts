import { describe, expect, it } from "vitest";
import redirects from "../../www/public/_redirects?raw";
import worker from "./index";

/** The static site the Worker falls through to, stubbed. */
const assets = {
  fetch: async () =>
    new Response("<!doctype html><title>Rakazo</title>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
};

/** The Worker answers from the static site, which the stub stands in for. */
function middleware(request: Request): Promise<Response> {
  return worker.fetch(request, { ASSETS: assets });
}

describe("marketing site middleware", () => {
  it("negotiates Markdown on the canonical page URL", async () => {
    const response = await middleware(
      new Request("https://rakazo.com/", {
        headers: { accept: "text/markdown,text/html;q=0.8" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    await expect(response.text()).resolves.toContain("# Rakazo");
  });

  it("serves HTML for pages that have no Markdown version", async () => {
    for (const path of ["/de/", "/ko/", "/zh/", "/de"]) {
      for (const accept of [null, "*/*", "text/markdown"]) {
        const headers = accept ? { accept } : undefined;
        const response = await middleware(new Request(`https://rakazo.com${path}`, { headers }));

        expect(response.status, `${path} ${accept ?? "(no accept)"}`).toBe(200);
        expect(response.headers.get("content-type")).not.toBe("text/markdown; charset=utf-8");
        expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
      }
    }
  });

  it("lets unknown URLs fall through to the HTML not-found page", async () => {
    const response = await middleware(
      new Request("https://rakazo.com/does-not-exist", {
        headers: { accept: "*/*" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).not.toBe("text/markdown; charset=utf-8");
  });

  it("returns 406 for representations the site does not provide", async () => {
    const response = await middleware(
      new Request("https://rakazo.com/", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(406);
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    await expect(response.text()).resolves.toContain("text/html or text/markdown");
  });

  it("continues browser requests with negotiation-safe response headers", async () => {
    const response = await middleware(
      new Request("https://rakazo.com/", {
        headers: { accept: "text/html" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    expect(response.headers.get("link")).toContain("/index.md");
  });

  it("leaves the asset paths to the static site", async () => {
    for (const path of ["/_astro/index.css", "/favicon.ico"]) {
      const response = await middleware(
        new Request(`https://rakazo.com${path}`, { headers: { accept: "text/html" } }),
      );

      expect(response.status, path).toBe(200);
      expect(response.headers.get("vary"), path).toBeNull();
    }
  });

  it("redirects www to the apex host", async () => {
    const response = await middleware(
      new Request("https://www.rakazo.com/de/?utm=site", { method: "HEAD" }),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://rakazo.com/de/?utm=site");
  });

  it("redirects /sitemap.xml to the sitemap index", async () => {
    const response = await middleware(new Request("https://rakazo.com/sitemap.xml"));

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/sitemap-index.xml");
  });

  it("keeps the hosting redirect aligned with the middleware", () => {
    expect(redirects).toContain("/sitemap.xml  /sitemap-index.xml  301");
  });
});
