import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  createAnthropicClient,
  createBedrockClient,
  createDryRunClient,
  createGatewayFromEnv,
  createOpenAiCompatibleClient,
  createPausedClient,
  LlmPausedError,
} from "../index.js";
const req = { operation: "summarize", prompt: "P", system: "S", maxTokens: 10 };
describe("providers and config", () => {
  it("paused client and default env mode throw", async () => {
    await expect(createPausedClient().complete(req)).rejects.toBeInstanceOf(
      LlmPausedError,
    );
    await expect(
      createGatewayFromEnv("X", {}).complete(req),
    ).rejects.toBeInstanceOf(LlmPausedError);
  });
  it("dry run serves three fixtures and logs missing", async () => {
    const c = createDryRunClient();
    for (const operation of ["generate-tasks", "summarize", "classify"])
      expect((await c.complete({ ...req, operation })).text).toBeTruthy();
    const error = vi.fn();
    await expect(
      createDryRunClient({
        logger: { log: vi.fn(), warn: vi.fn(), error },
      }).complete({ ...req, operation: "missing" }),
    ).rejects.toThrow();
    expect(error).toHaveBeenCalled();
  });
  it("bedrock folds system and omits top-level system and optional temperature", async () => {
    let body: any;
    const client = {
      send: vi.fn(async (cmd: any) => {
        body = JSON.parse(
          typeof cmd.input.body === "string"
            ? cmd.input.body
            : new TextDecoder().decode(cmd.input.body),
        );
        return {
          body: new TextEncoder().encode(
            '{"content":[{"type":"text","text":"ok"}]}',
          ),
        };
      }),
    };
    await createBedrockClient({ modelArn: "arn", client }).complete(req);
    expect(body.system).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.messages[0].content[0].text).toBe("S");
  });
  it("anthropic logs and reraises", async () => {
    const error = vi.fn();
    const c = createAnthropicClient({
      anthropicClient: {
        messages: {
          create: async () => {
            throw new Error("boom");
          },
        },
      },
      logger: { log: vi.fn(), warn: vi.fn(), error },
    });
    await expect(c.complete(req)).rejects.toThrow("boom");
    expect(error).toHaveBeenCalled();
  });
  it("openai-compatible shapes auth and schema", async () => {
    let url = "",
      init: any;
    const fetchImpl = vi.fn(async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response(
        '{"choices":[{"message":{"content":"{}"}}],"usage":{}}',
      );
    });
    await createOpenAiCompatibleClient({
      baseUrl: "https://x/",
      apiKey: "secret",
      model: "m",
      fetchImpl,
    }).complete({ ...req, schema: z.object({ x: z.string() }) });
    expect(url).toBe("https://x/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body).response_format.type).toBe("json_schema");
  });
  it("validates unknown modes and cache modes", () => {
    expect(() => createGatewayFromEnv("X", { X_LLM: "bad" })).toThrow("bad");
    expect(() => createGatewayFromEnv("X", { X_LLM_CACHE: "bad" })).toThrow(
      "bad",
    );
  });
});
