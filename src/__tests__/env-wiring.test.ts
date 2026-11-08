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
    expect(createGatewayFromEnv("SW", { SW_LLM: "paused" }, { logger: quiet }).providerName).toBe("paused");
  });
  it("testUnsetModeDefaultsToLocalOllamaQwen", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { content: "hi" }, prompt_eval_count: 1, eval_count: 1, done_reason: "stop" }) }));
    const g = createGatewayFromEnv("SW", { SW_LLM_CACHE: "off" }, { fetchImpl: fetchImpl as any, logger: quiet });
    expect(g.providerName).toBe("ollama");
    await g.complete({ operation: "op", prompt: "p", maxTokens: 5 });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(init.body).model).toBe("qwen2.5vl:7b");
  });
  it("testOllamaNumCtxFromEnv", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { content: "hi" }, prompt_eval_count: 1, eval_count: 1, done_reason: "stop" }) }));
    const g = createGatewayFromEnv("SW", { SW_LLM: "ollama", SW_OLLAMA_NUM_CTX: "16384", SW_LLM_CACHE: "off" }, { fetchImpl: fetchImpl as any, logger: quiet });
    await g.complete({ operation: "op", prompt: "p", maxTokens: 5 });
    const [, init] = fetchImpl.mock.calls[0] as any[];
    expect(JSON.parse(init.body).options.num_ctx).toBe(16384);
  });
  it("testOllamaNumCtxUnsetSendsNoNumCtx", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { content: "hi" }, prompt_eval_count: 1, eval_count: 1, done_reason: "stop" }) }));
    const g = createGatewayFromEnv("SW", { SW_LLM: "ollama", SW_LLM_CACHE: "off" }, { fetchImpl: fetchImpl as any, logger: quiet });
    await g.complete({ operation: "op", prompt: "p", maxTokens: 5 });
    const [, init] = fetchImpl.mock.calls[0] as any[];
    expect(JSON.parse(init.body).options).toEqual({ num_predict: 5 });
  });
  it("testOllamaNumCtxRejectsNonPositiveInteger", () => {
    for (const value of ["0", "-1", "1.5", "abc"])
      expect(() => createGatewayFromEnv("SW", { SW_LLM: "ollama", SW_OLLAMA_NUM_CTX: value }, { logger: quiet })).toThrow("SW_OLLAMA_NUM_CTX must be a positive integer");
  });
  it("testTransportRetryBoundZeroMakesOneAttempt", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("down"); });
    const g = createGatewayFromEnv("SW", { SW_LLM: "ollama", SW_LLM_CACHE: "off" }, { fetchImpl: fetchImpl as any, logger: quiet, transportRetryBound: 0 });
    await expect(g.complete({ operation: "op", prompt: "p", maxTokens: 5 })).rejects.toThrow("down");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
