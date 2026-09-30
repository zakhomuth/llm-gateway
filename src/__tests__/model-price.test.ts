import { describe, it, expect, vi } from "vitest";
import {
  costUsd,
  createGatewayFromEnv,
  DEFAULT_ANTHROPIC_MODEL,
  FREE_PRICE,
  lookupPrice,
  resolvePrice,
  UNKNOWN_MODEL_PRICE,
} from "../index.js";
const M = 1_000_000;
const req = { operation: "summarize", prompt: "P", maxTokens: 10 };
const quiet = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
function fakeAnthropic() {
  return {
    messages: {
      create: vi.fn(async (_body: any) => ({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: M, output_tokens: M },
      })),
    },
  };
}
describe("model ids and prices", () => {
  it("resolves current Claude API, dated and Bedrock ids", () => {
    expect(lookupPrice("claude-opus-5-5")).toEqual({ inputPerMillionUsd: 4, outputPerMillionUsd: 20 });
    expect(lookupPrice("claude-fable-5-1")).toEqual({ inputPerMillionUsd: 10, outputPerMillionUsd: 50 });
    expect(lookupPrice("claude-sonnet-5-5")).toEqual({ inputPerMillionUsd: 2, outputPerMillionUsd: 10 });
    expect(lookupPrice("claude-haiku-4-5-20251001")).toEqual({ inputPerMillionUsd: 1, outputPerMillionUsd: 5 });
    expect(
      lookupPrice("arn:aws:bedrock:region:000000000000:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    ).toEqual({ inputPerMillionUsd: 3, outputPerMillionUsd: 15 });
  });
  it("longest family wins (opus-4-5 is not billed as opus-4)", () => {
    expect(resolvePrice("claude-opus-4-5").inputPerMillionUsd).toBe(5);
    expect(resolvePrice("claude-opus-4-20250514").inputPerMillionUsd).toBe(15);
  });
  it("unknown model costs at the highest listed rate", () => {
    expect(lookupPrice("llama3")).toBeUndefined();
    expect(resolvePrice("llama3")).toEqual(UNKNOWN_MODEL_PRICE);
    expect(costUsd("x", { inputTokens: M, outputTokens: M }, FREE_PRICE)).toBe(0);
  });
  it("anthropic mode defaults to a current model and bills it", async () => {
    const anthropicClient = fakeAnthropic();
    const g = createGatewayFromEnv("x", { X_LLM: "anthropic" }, { anthropicClient, logger: quiet() });
    const r = await g.complete(req);
    expect(anthropicClient.messages.create.mock.calls[0][0].model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(r.costUsd).toBe(12);
  });
  it("price override env applies and unknown model warns without it", async () => {
    const logger = quiet();
    const anthropicClient = fakeAnthropic();
    const g = createGatewayFromEnv(
      "x",
      { X_LLM: "anthropic", X_LLM_MODEL: "my-custom", X_LLM_PRICE_PER_MTOK: "1.5/2.5" },
      { anthropicClient, logger },
    );
    expect((await g.complete(req)).costUsd).toBe(4);
    expect(logger.warn).not.toHaveBeenCalled();
    const warned = quiet();
    createGatewayFromEnv("x", { X_LLM: "anthropic", X_LLM_MODEL: "my-custom" }, { anthropicClient, logger: warned });
    expect(warned.warn).toHaveBeenCalledOnce();
    expect(() =>
      createGatewayFromEnv("x", { X_LLM: "anthropic", X_LLM_PRICE_PER_MTOK: "cheap" }, { anthropicClient, logger: quiet() }),
    ).toThrow("PRICE_PER_MTOK");
  });
  it("ollama is free", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: { content: "ok" }, prompt_eval_count: M, eval_count: M, done_reason: "stop" })),
    );
    const g = createGatewayFromEnv("x", { X_LLM: "ollama" }, { fetchImpl: fetchImpl as any, logger: quiet() });
    expect((await g.complete(req)).costUsd).toBe(0);
  });
});
