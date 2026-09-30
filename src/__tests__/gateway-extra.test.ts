import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createGatewayFromEnv,
  Gateway,
  InMemoryCacheStore,
  InMemoryInflightLedger,
  LlmPausedError,
  requestKey,
} from "../index.js";

const req = (extra: Record<string, unknown> = {}) => ({
  operation: "op",
  prompt: "P",
  maxTokens: 10,
  ...extra,
});
const output = (text: string) => ({
  text,
  usage: { inputTokens: 5, outputTokens: 7 },
});

describe("gateway edge behavior", () => {
  it("testStructuredMissThenHit", async () => {
    const complete = vi.fn(async () => output('{"name":"live"}'));
    const gateway = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
    });
    const request = req({ schema: z.object({ name: z.string() }) });
    expect((await gateway.complete(request)).parsed).toEqual({ name: "live" });
    expect((await gateway.complete(request)).parsed).toEqual({ name: "live" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("testCachedEntryThatNoLongerValidatesReissues", async () => {
    const store = new InMemoryCacheStore();
    const request = req({ schema: z.object({ name: z.string() }) });
    const key = requestKey(request, "fake", "m");
    await store.put(key, { text: '{"name":1}', prompt: "P", meta: {} });
    const complete = vi.fn(async () => output('{"name":"fixed"}'));
    const warn = vi.fn();
    const gateway = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store,
      ledger: new InMemoryInflightLedger(),
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });
    expect((await gateway.complete(request)).parsed).toEqual({ name: "fixed" });
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("no longer validates");
  });

  it("testSamplesAreDistinctMissesWithoutChangingPrompt", async () => {
    const prompts: string[] = [];
    const gateway = new Gateway({
      provider: {
        provider: "fake",
        complete: async (request) => {
          prompts.push(request.prompt!);
          return output("ok");
        },
      },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
    });
    for (const sample of [0, 1, 2]) await gateway.complete(req({ sample }));
    await gateway.complete(req({ sample: 1 }));
    expect(prompts).toEqual(["P", "P", "P"]);
  });

  it("testPutPersistsFullPrompt", async () => {
    const store = new InMemoryCacheStore();
    const prompt = "x".repeat(5000);
    const gateway = new Gateway({
      provider: { provider: "fake", complete: async () => output("ok") },
      model: "m",
      store,
      ledger: new InMemoryInflightLedger(),
    });
    await gateway.complete(req({ prompt }));
    expect(
      (await store.get(requestKey(req({ prompt }), "fake", "m")))?.prompt,
    ).toBe(prompt);
  });

  it("testRefreshEnvForcesLive", async () => {
    const store = new InMemoryCacheStore();
    const anthropicClient = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: "text", text: "live" }],
        })),
      },
    };
    const env = { X_LLM: "anthropic", X_LLM_MODEL: "m", X_LLM_REFRESH: "1" };
    const gateway = createGatewayFromEnv("x", env, { store, anthropicClient });
    await store.put(requestKey(req(), "anthropic", "m"), {
      text: "cached",
      prompt: "P",
      meta: {},
    });
    expect((await gateway.complete(req())).text).toBe("live");
    expect(anthropicClient.messages.create).toHaveBeenCalledOnce();
  });

  it("testNoBatchEnvDowngradesToDirect", async () => {
    const complete = vi.fn(async () => output("direct"));
    const issueBatch = vi.fn(async () => [output("batch")]);
    const gateway = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
      issueBatch,
      noBatch: true,
    });
    expect((await gateway.completeMany([req()]))[0]?.text).toBe("direct");
    expect(issueBatch).not.toHaveBeenCalled();
  });

  it("testManyAggregatesMissesIntoOneBatch", async () => {
    const issueBatch = vi.fn(async (requests) =>
      requests.map((request) => output(request.prompt!)),
    );
    const gateway = new Gateway({
      provider: { provider: "fake", complete: vi.fn() },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
      issueBatch,
    });
    expect(
      (
        await gateway.completeMany([
          req({ prompt: "P1" }),
          req({ prompt: "P2" }),
        ])
      ).map((value) => value?.text),
    ).toEqual(["P1", "P2"]);
    expect(issueBatch).toHaveBeenCalledOnce();
  });

  it("testReplayOnlyInvalidStructuredHitIsAMiss", async () => {
    const store = new InMemoryCacheStore();
    const request = req({ schema: z.object({ name: z.string() }) });
    await store.put(requestKey(request, "fake", "m"), {
      text: "{}",
      prompt: "P",
      meta: {},
    });
    const gateway = new Gateway({
      provider: { provider: "fake", complete: vi.fn() },
      model: "m",
      store,
      ledger: new InMemoryInflightLedger(),
      cacheMode: "replay-only",
    });
    await expect(gateway.complete(request)).rejects.toBeInstanceOf(
      LlmPausedError,
    );
  });
});
