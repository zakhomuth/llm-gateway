import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __resetShutdownStateForTests,
  deferredShutdown,
  FileInflightLedger,
  Gateway,
  holderAlive,
  InMemoryCacheStore,
  InMemoryInflightLedger,
  LlmBudgetExceededError,
  LlmPausedError,
  reportStale,
  requestKey,
  TransportFailure,
} from "../index.js";
// SKIPPED: test_subscription_engine_bypasses_batch — no engine/auth routing; batchable/noBatch cover the generic switch.
// PORTED as testAdoptBatchPastCapSinceCreationRaisesWithoutPolling in batch-extra.test.ts — it exercises AnthropicBatchBroker.adopt directly (the transports.adopt_batch unit), not Gateway.
const req = (extra: Record<string, unknown> = {}) => ({
  operation: "op",
  prompt: "P",
  maxTokens: 10,
  ...extra,
});
const result = (text = "ok") => ({
  text,
  usage: { inputTokens: 2, outputTokens: 3 },
});
describe("gateway ports", () => {
  beforeEach(() => __resetShutdownStateForTests());
  it("testStaleSyncMarkerIsTakenOver", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-ledger-"));
    const ledger = new FileInflightLedger(root);
    const store = new InMemoryCacheStore();
    const complete = vi.fn(async () => result("live"));
    const g = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store,
      ledger,
    });
    const key = requestKey(req(), "fake", "m");
    await ledger.open(key, { operation: "op" });
    const markerPath = path.join(root, "inflight", `${key}.json`);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.pid = 2 ** 22 + 7919;
    await writeFile(markerPath, JSON.stringify(marker));
    expect((await g.complete(req())).text).toBe("live");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("testAdoptTimeoutReissuesDirectNotBatch", async () => {
    const ledger = new InMemoryInflightLedger();
    const complete = vi.fn(async () => result("live"));
    const key = requestKey(req(), "fake", "m");
    await ledger.open(key, { operation: "op" });
    await ledger.setBatchId(key, "batch_stalled");
    const adoptBatch = vi.fn(async () => {
      throw new Error(
        "batch batch_stalled stalled: still in_progress 7300s after creation",
      );
    });
    const g = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger,
      adoptBatch,
    });
    expect((await g.complete(req())).text).toBe("live");
    expect(complete).toHaveBeenCalledOnce();
    expect(await ledger.read(key)).toBeNull();
  });

  it("testMarkerWithBatchIdIsAdoptedNotResubmitted", async () => {
    const ledger = new InMemoryInflightLedger();
    const store = new InMemoryCacheStore();
    const complete = vi.fn(async () => result("should-not-be-called"));
    const key = requestKey(req(), "fake", "m");
    await ledger.open(key, { operation: "op" });
    await ledger.setBatchId(key, "batch_1");
    const adoptBatch = vi.fn(async () => result("ORIGINAL"));
    const g = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store,
      ledger,
      adoptBatch,
    });
    expect((await g.complete(req())).text).toBe("ORIGINAL");
    expect(adoptBatch).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(await ledger.read(key)).toBeNull();
    expect((await store.get(key))?.text).toBe("ORIGINAL");
  });

  it("testWrapAskDrainsAndCaches (adapted: complete() integrates deferredShutdown)", async () => {
    const resent: string[] = [];
    const complete = vi.fn(async () => {
      process.emit("SIGTERM", "SIGTERM");
      return result("RESPONSE");
    });
    const store = new InMemoryCacheStore();
    const g = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store,
      ledger: new InMemoryInflightLedger(),
      resend: (_pid, signal) => resent.push(signal),
    });
    expect((await g.complete(req())).text).toBe("RESPONSE");
    expect(await store.get(requestKey(req(), "fake", "m"))).not.toBeNull();
    expect(resent).toEqual(["SIGTERM"]);
  });

  it("complete miss then hit, marker closes, fresh overwrites", async () => {
    const store = new InMemoryCacheStore(),
      ledger = new InMemoryInflightLedger(),
      complete = vi.fn(async () => result("one"));
    const g = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store,
      ledger,
    });
    expect((await g.complete(req())).cached).toBe(false);
    expect((await g.complete(req())).cached).toBe(true);
    complete.mockResolvedValue(result("two"));
    expect((await g.complete(req({ fresh: true }))).text).toBe("two");
    expect(await ledger.markers()).toEqual([]);
  });
  it("transient response is not cached", async () => {
    const complete = vi.fn(async () => result("Credit balance is too low")),
      g = new Gateway({
        provider: { provider: "fake", complete },
        model: "m",
        store: new InMemoryCacheStore(),
        ledger: new InMemoryInflightLedger(),
      });
    await g.complete(req());
    await g.complete(req());
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("retries to bound and drops marker", async () => {
    const ledger = new InMemoryInflightLedger(),
      complete = vi.fn().mockRejectedValue(new Error("down")),
      g = new Gateway({
        provider: { provider: "fake", complete },
        model: "m",
        store: new InMemoryCacheStore(),
        ledger,
        transportRetryBound: 2,
      });
    await expect(g.complete(req())).rejects.toThrow("down");
    expect(complete).toHaveBeenCalledTimes(3);
    expect(await ledger.markers()).toEqual([]);
  });
  it("completeMany skips hit, batches eligible, singles batchable false", async () => {
    const store = new InMemoryCacheStore(),
      ledger = new InMemoryInflightLedger(),
      provider = vi.fn(async () => result("single")),
      issueBatch = vi.fn(async (rs) => rs.map(() => result("batch"))),
      g = new Gateway({
        provider: { provider: "fake", complete: provider },
        model: "m",
        store,
        ledger,
        issueBatch,
      });
    await store.put(requestKey(req({ prompt: "hit" }), "fake", "m"), {
      text: "hit",
      prompt: "hit",
      meta: {},
    });
    const out = await g.completeMany([
      req({ prompt: "hit" }),
      req({ prompt: "batch" }),
      req({ prompt: "single", batchable: false }),
    ]);
    expect(out.map((x) => x?.text)).toEqual(["hit", "batch", "single"]);
    expect(issueBatch).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("batch TransportFailure falls back then nulls after retries", async () => {
    const g = new Gateway({
      provider: {
        provider: "fake",
        complete: async () => {
          throw new Error("down");
        },
      },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
      issueBatch: async () => [new TransportFailure("refusal")],
      transportRetryBound: 0,
    });
    expect(await g.completeMany([req()])).toEqual([null]);
  });
  it("daily cap blocks miss but permits hit", async () => {
    const store = new InMemoryCacheStore(),
      ledger = new InMemoryInflightLedger(),
      provider = vi.fn(async () => result()),
      spend = { record: vi.fn(), dailySpendUsd: vi.fn(async () => 10) },
      g = new Gateway({
        provider: { provider: "fake", complete: provider },
        model: "m",
        store,
        ledger,
        spendLedger: spend,
        dailyCapUsd: 10,
      });
    await expect(g.complete(req())).rejects.toBeInstanceOf(
      LlmBudgetExceededError,
    );
    await store.put(requestKey(req({ prompt: "hit" }), "fake", "m"), {
      text: "hit",
      prompt: "hit",
      meta: {},
    });
    expect((await g.complete(req({ prompt: "hit" }))).text).toBe("hit");
  });
  it("replay-only hit works and miss pauses without provider", async () => {
    const store = new InMemoryCacheStore(),
      provider = vi.fn(async () => result()),
      g = new Gateway({
        provider: { provider: "fake", complete: provider },
        model: "m",
        store,
        ledger: new InMemoryInflightLedger(),
        cacheMode: "replay-only",
      });
    await store.put(requestKey(req(), "fake", "m"), {
      text: "hit",
      prompt: "P",
      meta: {},
    });
    expect((await g.complete(req())).text).toBe("hit");
    await expect(g.complete(req({ prompt: "miss" }))).rejects.toBeInstanceOf(
      LlmPausedError,
    );
    expect(provider).not.toHaveBeenCalled();
  });
});
describe("ledger and drain ports", () => {
  it("dead holder and stale report classify lost/recoverable", () => {
    const dead = { key: "x", pid: 2 ** 22 + 7919, startedAt: 0 };
    expect(holderAlive(dead)).toBe(false);
    const error = vi.fn(),
      warn = vi.fn();
    reportStale([dead, { ...dead, key: "y", batchId: "b" }], {
      log: vi.fn(),
      error,
      warn,
    });
    expect(error.mock.calls[0]?.[0]).toContain("lost");
    expect(warn.mock.calls[0]?.[0]).toContain("recoverable");
  });
  it("deferred shutdown records then redelivers and refuses future calls", async () => {
    const resend = vi.fn();
    await deferredShutdown(
      async () => {
        process.emit("SIGTERM", "SIGTERM");
        return 1;
      },
      { resend },
    );
    expect(resend).toHaveBeenCalled();
    await expect(deferredShutdown(async () => 1, { resend })).rejects.toThrow();
  });
});
