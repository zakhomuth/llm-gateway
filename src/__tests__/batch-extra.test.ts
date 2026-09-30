import { describe, expect, it, vi } from "vitest";
import {
  AnthropicBatchBroker,
  InMemoryCacheStore,
  InMemoryInflightLedger,
  requestKey,
  TransportFailure,
} from "../index.js";

const request = (prompt = "P") => ({ operation: "op", prompt, maxTokens: 10 });
const keyOf = (req: ReturnType<typeof request>) =>
  requestKey(req, "anthropic", "m");

function clientFor(result: (key: string) => any, endedAfter = 0) {
  const submitted: Array<{ custom_id: string; params: unknown }> = [];
  let polls = 0;
  return {
    submitted,
    create: vi.fn(async ({ requests }: { requests: typeof submitted }) => {
      submitted.push(...requests);
      return { id: "batch_1" };
    }),
    retrieve: vi.fn(async () => ({
      processing_status: polls++ >= endedAfter ? "ended" : "in_progress",
    })),
    async *results() {
      for (const row of submitted)
        yield { custom_id: row.custom_id, result: result(row.custom_id) };
    },
  };
}

const success = (text = "ok", stop_reason = "end_turn") => ({
  type: "succeeded",
  message: {
    content: [{ type: "text", text }],
    stop_reason,
    usage: { output_tokens: 4 },
  },
});

describe("Anthropic batch broker ports", () => {
  it("testAdoptBatchPastCapSinceCreationRaisesWithoutPolling", async () => {
    const sleep = vi.fn(async () => {});
    const oldCreatedAt = new Date(Date.now() - 7_260_000).toISOString();
    const client = {
      create: vi.fn(),
      retrieve: vi.fn(async () => ({
        processing_status: "in_progress",
        created_at: oldCreatedAt,
      })),
      async *results() {
        /* unreachable */
      },
    };
    const broker = new AnthropicBatchBroker(
      client,
      new InMemoryCacheStore(),
      new InMemoryInflightLedger(),
      { sleep },
    );
    await expect(broker.adopt("batch_old", "some-key")).rejects.toThrow(
      /stalled/,
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(client.retrieve).toHaveBeenCalledOnce();
  });

  it("testBatchIssuePollsThenHarvests", async () => {
    const client = clientFor(() => success(), 2);
    const sleeps: number[] = [];
    const ledger = new InMemoryInflightLedger();
    for (const req of [request("a"), request("b")])
      await ledger.open(keyOf(req), { operation: req.operation });
    const broker = new AnthropicBatchBroker(
      client,
      new InMemoryCacheStore(),
      ledger,
      {
        keyOf,
        pollStartMs: 1,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(
      (await broker.issueBatch([request("a"), request("b")])).map(
        (row) => row.text,
      ),
    ).toEqual(["ok", "ok"]);
    expect(sleeps).toEqual([1, 2]);
  });

  it("testBatchProviderErrorsFailClosedAndClearForRetry", async () => {
    const client = clientFor(() => ({
      type: "errored",
      error: { type: "invalid_request_error" },
    }));
    const ledger = new InMemoryInflightLedger();
    const req = request();
    await ledger.open(keyOf(req), { operation: req.operation });
    const out = await new AnthropicBatchBroker(
      client,
      new InMemoryCacheStore(),
      ledger,
      { keyOf },
    ).issueBatch([req]);
    expect(out[0]).toBeInstanceOf(TransportFailure);
    expect(await ledger.markers()).toEqual([]);
  });

  it("testBatchPauseTurnFailsClosedAndClearsForRetry", async () => {
    const client = clientFor(() => success("partial", "pause_turn"));
    const ledger = new InMemoryInflightLedger();
    const req = request();
    await ledger.open(keyOf(req), { operation: req.operation });
    const out = await new AnthropicBatchBroker(
      client,
      new InMemoryCacheStore(),
      ledger,
      { keyOf },
    ).issueBatch([req]);
    expect(out[0]).toBeInstanceOf(TransportFailure);
    expect(await ledger.markers()).toEqual([]);
  });

  it("testBatchDedupsIdenticalPrompts", async () => {
    const client = clientFor((key) => success(key));
    const out = await new AnthropicBatchBroker(
      client,
      new InMemoryCacheStore(),
      new InMemoryInflightLedger(),
      { keyOf },
    ).issueBatch([request("same"), request("same"), request("other")]);
    expect(client.submitted).toHaveLength(2);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(out[1]);
  });

  it("testBatchStructuredSubmitsCustomIdEqualsKeyAndValidates", async () => {
    const client = clientFor(() => success('{"name":"ok"}'));
    const req = request();
    await new AnthropicBatchBroker(
      client,
      new InMemoryCacheStore(),
      new InMemoryInflightLedger(),
      { keyOf },
    ).issueBatch([req]);
    expect(client.submitted[0]?.custom_id).toBe(keyOf(req));
  });

  it("testGatewayBatchesClaudeMissesAndRecordsBatchId", async () => {
    const client = clientFor(() => success());
    const req = request();
    const ledger = new InMemoryInflightLedger();
    await ledger.open(keyOf(req), { operation: req.operation });
    let observed: string | undefined;
    const original = ledger.setBatchId.bind(ledger);
    ledger.setBatchId = async (key, batchId) => {
      observed = batchId;
      await original(key, batchId);
    };
    await new AnthropicBatchBroker(client, new InMemoryCacheStore(), ledger, {
      keyOf,
    }).issueBatch([req]);
    expect(observed).toBe("batch_1");
  });

  it("testMarkerWithBatchIdIsAdoptedNotResubmitted", async () => {
    const req = request();
    const key = keyOf(req);
    const ledger = new InMemoryInflightLedger();
    const store = new InMemoryCacheStore();
    await ledger.open(key, { operation: req.operation });
    await ledger.setBatchId(key, "batch_old");
    const client = {
      create: vi.fn(),
      retrieve: vi.fn(async () => ({ processing_status: "ended" })),
      async *results() {
        yield { custom_id: key, result: success("recovered") };
      },
    };
    expect(
      await new AnthropicBatchBroker(client, store, ledger, {
        keyOf,
      }).harvestPending(),
    ).toBe(1);
    expect(client.create).not.toHaveBeenCalled();
    expect((await store.get(key))?.text).toBe("recovered");
  });

  it("testBatchHarvestPendingIsKillProof", async () => {
    const ledger = new InMemoryInflightLedger();
    for (const [key, batchId] of [
      ["a", "bad"],
      ["b", "good"],
    ] as const) {
      await ledger.open(key, {});
      await ledger.setBatchId(key, batchId);
    }
    const error = vi.fn();
    const client = {
      create: vi.fn(),
      retrieve: vi.fn(async (id: string) => {
        if (id === "bad") throw new Error("network");
        return { processing_status: "ended" };
      }),
      async *results(id: string) {
        yield { custom_id: "b", result: success(id) };
      },
    };
    expect(
      await new AnthropicBatchBroker(client, new InMemoryCacheStore(), ledger, {
        logger: { log: vi.fn(), warn: vi.fn(), error },
      }).harvestPending(),
    ).toBe(1);
    expect(error).toHaveBeenCalled();
    expect(await ledger.read("a")).not.toBeNull();
  });

  it("testBatchHarvestLegacyMarkerPreservesOriginalKey", async () => {
    const ledger = new InMemoryInflightLedger();
    const store = new InMemoryCacheStore();
    await ledger.open("legacy-key", {});
    await ledger.setBatchId("legacy-key", "batch");
    const client = {
      create: vi.fn(),
      retrieve: async () => ({ processing_status: "ended" }),
      async *results() {
        yield { custom_id: "legacy-key", result: success("legacy") };
      },
    };
    await new AnthropicBatchBroker(client, store, ledger).harvestPending();
    expect((await store.get("legacy-key"))?.text).toBe("legacy");
  });
});
