import { describe, it, expect, vi } from "vitest";
import { createGatewayFromEnv } from "../index.js";
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
describe("env wiring", () => {
  it("testOllamaUsesLlmBaseUrl", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { content: "hi" }, prompt_eval_count: 1, eval_count: 1, done_reason: "stop" }) }));
    const g = createGatewayFromEnv("SW", { SW_LLM: "ollama", SW_LLM_BASE_URL: "http://host.docker.internal:11434", SW_LLM_CACHE: "off" }, { fetchImpl: fetchImpl as any, logger: quiet });
    await g.complete({ operation: "op", prompt: "p", maxTokens: 5 });
    expect((fetchImpl.mock.calls[0] as any[])[0]).toBe("http://host.docker.internal:11434/api/chat");
    expect(g.providerName).toBe("ollama");
  });
  it("testPausedProviderName", () => {
    expect(createGatewayFromEnv("SW", {}, { logger: quiet }).providerName).toBe("paused");
  });
  it("testTransportRetryBoundZeroMakesOneAttempt", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("down"); });
    const g = createGatewayFromEnv("SW", { SW_LLM: "ollama", SW_LLM_CACHE: "off" }, { fetchImpl: fetchImpl as any, logger: quiet, transportRetryBound: 0 });
    await expect(g.complete({ operation: "op", prompt: "p", maxTokens: 5 })).rejects.toThrow("down");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
