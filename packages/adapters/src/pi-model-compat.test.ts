import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { applyPiModelCompatibility } from "./pi-model-compat.js";

function fixtureResponse(modelId: string): Response {
  const chunks = [
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    },
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("applyPiModelCompatibility", () => {
  it("sends Groq the system instruction role", async () => {
    const models = applyPiModelCompatibility(builtinModels());
    const model = models.getModel("groq", "qwen/qwen3.8-27b");
    expect(model?.compat).toMatchObject({ supportsDeveloperRole: false });

    let payload: { messages: Array<{ role: string }> } | undefined;
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      return fixtureResponse("qwen/qwen3.8-27b");
    });
    const stream = models.streamSimple(
      model!,
      {
        systemPrompt: "Use the fixture.",
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
      { apiKey: "test", fetch: mockFetch },
    );
    for await (const _event of stream) {
      // Drain the stream so the request completes.
    }
    await stream.result();

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(payload?.messages[0]).toMatchObject({ role: "system" });
  });
});
