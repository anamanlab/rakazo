import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
} from "@rakazo/contracts";
import * as Core from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { cloudflareModelProviderEnv, withCloudflareModelAuth } from "./cloudflare-ai-gateway.js";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { parseModelSecret } from "./pi-oauth.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const ACCOUNT_ID = "acct1234";
const GATEWAY_ID = "gateway-1";
const API_KEY = "cf-test-key-value";

describe("Cloudflare Workers AI auth", () => {
  it("still retries temporary HTTP failures through the runtime policy", async () => {
    const delay = vi.spyOn(Core, "abortableDelay").mockResolvedValue(undefined);
    let calls = 0;
    try {
      const runtime = new PiAgentRuntime({
        modelFetch: async () => {
          calls++;
          if (calls === 1)
            return Response.json(
              { error: { message: "Service temporarily unavailable" } },
              { status: 503 },
            );
          return new Response(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const events = [];
      for await (const event of runtime.run({
        runId: "temporary-overload-fixture",
        botId: "bot-fixture",
        threadId: "thread-fixture",
        prompt: "Ping",
        instructions: "Answer briefly.",
        history: [],
        tools: [],
        model: {
          provider: "cloudflare-workers-ai",
          id: "@cf/zai-org/glm-4.7-flash",
          apiKey: API_KEY,
          accountId: ACCOUNT_ID,
          maxTokens: 2048,
        },
      }))
        events.push(event);
      expect(events).toContainEqual({ type: "done", text: "Ready" });
      expect(calls).toBe(2);
      expect(delay).toHaveBeenCalledTimes(1);
    } finally {
      delay.mockRestore();
    }
  });

  it("does not hide a second HTTP request behind a daily-quota error", async () => {
    let calls = 0;
    const runtime = new PiAgentRuntime({
      modelFetch: async () => {
        calls++;
        return Response.json(
          {
            errors: [
              {
                code: 4006,
                message: "You have used up your daily free allocation of 10,000 neurons.",
              },
            ],
          },
          { status: 429, headers: { "retry-after-ms": "1" } },
        );
      },
    });
    const consume = async () => {
      for await (const _event of runtime.run({
        runId: "daily-quota-fixture",
        botId: "bot-fixture",
        threadId: "thread-fixture",
        prompt: "Ping",
        instructions: "Answer briefly.",
        history: [],
        tools: [],
        model: {
          provider: "cloudflare-workers-ai",
          id: "@cf/zai-org/glm-4.7-flash",
          apiKey: API_KEY,
          accountId: ACCOUNT_ID,
          maxTokens: 2048,
        },
      })) {
        /* Consume the terminal provider failure. */
      }
    };
    await expect(consume()).rejects.toThrow("daily free allocation");
    expect(calls).toBe(1);
  });

  it("saves account routing and output limits without requiring a gateway", () => {
    const plaintext = buildModelConnectPlaintext({
      provider: "cloudflare-workers-ai",
      apiKey: API_KEY,
      accountId: ACCOUNT_ID,
      maxTokens: 2048,
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "api_key",
      key: API_KEY,
      accountId: ACCOUNT_ID,
      maxTokens: 2048,
    });
    expect(
      parseModelSecret(
        buildModelConnectPlaintext(
          { provider: "cloudflare-workers-ai", maxTokens: 1024 },
          plaintext,
        ),
      ),
    ).toMatchObject({ accountId: ACCOUNT_ID, maxTokens: 1024 });
    expect(() =>
      buildModelConnectPlaintext({ provider: "cloudflare-workers-ai", apiKey: API_KEY }),
    ).toThrow("Cloudflare Workers AI needs an account ID.");
  });

  it("routes the real runtime to the saved account with bearer auth and its output cap", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const runtime = new PiAgentRuntime({
      modelFetch: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const events = [];
    for await (const event of runtime.run({
      runId: "direct-cloudflare-fixture",
      botId: "bot-fixture",
      threadId: "thread-fixture",
      prompt: "Ping",
      instructions: "Answer briefly.",
      history: [],
      tools: [],
      model: {
        provider: "cloudflare-workers-ai",
        id: "@cf/zai-org/glm-4.7-flash",
        apiKey: API_KEY,
        accountId: ACCOUNT_ID,
        maxTokens: 2048,
      },
    }))
      events.push(event);
    expect(events).toContainEqual({ type: "done", text: "Ready" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
    );
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]!.headers.has("cf-aig-authorization")).toBe(false);
    expect(requests[0]!.body.max_tokens ?? requests[0]!.body.max_completion_tokens).toBe(2048);
  });
});

describe("Cloudflare AI Gateway auth", () => {
  it("resolves a saved credential into gateway auth and a routed base URL", async () => {
    const secret = parseModelSecret(
      buildModelConnectPlaintext({
        provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
        apiKey: API_KEY,
        accountId: ACCOUNT_ID,
        gatewayId: GATEWAY_ID,
      }),
    );
    expect(secret.kind).toBe("api_key");
    if (secret.kind !== "api_key") return;
    const modelConfig = {
      provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
      accountId: secret.accountId,
      gatewayId: secret.gatewayId,
    };
    const env = cloudflareModelProviderEnv(modelConfig);
    expect(withCloudflareModelAuth(modelConfig, { apiKey: API_KEY })?.env).toEqual(env);

    const models = builtinModels();
    const provider = models.getProvider(CLOUDFLARE_AI_GATEWAY_PROVIDER_ID);
    const model = provider?.getModels()[0];
    expect(model).toBeDefined();
    if (!model) return;

    const auth = await models.getAuth(model, { apiKey: API_KEY, env });
    expect(auth?.auth.headers?.["cf-aig-authorization"]).toBe(`Bearer ${API_KEY}`);

    let requestedUrl = "";
    let gatewayAuthorization: string | null = null;
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      {
        apiKey: API_KEY,
        env,
        maxRetries: 0,
        fetch: async (input, init) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          gatewayAuthorization = headers.get("cf-aig-authorization");
          return new Response("unauthorized", { status: 401 });
        },
      },
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(requestedUrl).toContain(`/v1/${ACCOUNT_ID}/${GATEWAY_ID}/`);
    expect(requestedUrl).not.toContain("{CLOUDFLARE_");
    expect(gatewayAuthorization).toBe(`Bearer ${API_KEY}`);
  });

  it("classifies a gateway credential that cannot be routed", async () => {
    expect(() =>
      cloudflareModelProviderEnv({ provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID }),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
    expect(() =>
      cloudflareModelProviderEnv({
        provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
        accountId: "acct/secret",
        gatewayId: GATEWAY_ID,
      }),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);

    const models = builtinModels();
    const model = models.getProvider(CLOUDFLARE_AI_GATEWAY_PROVIDER_ID)?.getModels()[0];
    expect(model).toBeDefined();
    if (!model) return;
    await expect(models.getAuth(model, { apiKey: API_KEY })).resolves.toBeUndefined();
    expect(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE).not.toContain("Provider is not configured");
  });

  it("keeps saved routing ids ahead of caller env", () => {
    const model = {
      provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
      accountId: ACCOUNT_ID,
      gatewayId: GATEWAY_ID,
    };
    expect(
      withCloudflareModelAuth(model, {
        env: {
          CLOUDFLARE_ACCOUNT_ID: "other-account",
          CLOUDFLARE_GATEWAY_ID: "other-gateway",
          OTHER: "kept",
        },
      })?.env,
    ).toEqual({
      OTHER: "kept",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_GATEWAY_ID: GATEWAY_ID,
    });
  });

  it("leaves other providers unchanged", () => {
    const options = { apiKey: "sk-test-key-123" };
    expect(withCloudflareModelAuth({ provider: "openai" }, options)).toBe(options);
  });
});
