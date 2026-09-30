import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  AnthropicBatchBroker,
  costUsd,
  InMemoryCacheStore,
  InMemoryInflightLedger,
  isBadStopReason,
  TransportFailure,
  utcDateString,
} from "../index.js";
describe("batch and cost", () => {
  it("testBatchStructuredResubmitsOnValidationMiss", async () => {
    const ledger = new InMemoryInflightLedger();
    const schemaReq = {
      operation: "op",
      prompt: "P",
      maxTokens: 10,
      schema: z.object({ name: z.string() }),
    };
    await ledger.open("k", { operation: "op" });
    const client = {
      create: vi.fn(async () => ({ id: "b" })),
      retrieve: vi.fn(async () => ({ processing_status: "ended" })),
      async *results() {
        yield {
          custom_id: "k",
          result: {
            type: "succeeded",
            message: {
              content: [{ type: "tool_use", input: { wrong_field: 1 } }],
              stop_reason: "end_turn",
              usage: { output_tokens: 2 },
            },
          },
        };
      },
    };
    const broker = new AnthropicBatchBroker(
      client,
      new InMemoryCacheStore(),
      ledger,
      {
        keyOf: () => "k",
        sleep: async () => {},
      },
    );
    const out = await broker.issueBatch([schemaReq]);
    expect(out[0]).toBeInstanceOf(TransportFailure);
    expect(await ledger.markers()).toEqual([]);
  });

  it("testBatchParamsAutoToolChoice", async () => {
    const { buildStructuredToolParams } = await import(
      "../providers/message-shape.js"
    );
    const schemaReq = {
      operation: "op",
      prompt: "P",
      maxTokens: 10,
      schema: z.object({ name: z.string() }),
    };
    const forced = buildStructuredToolParams(schemaReq);
    const auto = buildStructuredToolParams({
      ...schemaReq,
      autoTool: true,
      system: "S",
    });
    expect(forced.tool_choice).toEqual({
      type: "tool",
      name: "emit_structured_result",
    });
    expect(auto.tool_choice).toEqual({ type: "auto" });
    expect(auto.system).toBe(
      "S\n\nReturn only the tool call and no additional text.",
    );
    expect(auto.tools).toEqual(forced.tools);
  });

  it("classifies bad stop reasons", () => {
    for (const r of ["pause_turn", "max_tokens", "refusal"])
      expect(isBadStopReason(r)).toBe(true);
    expect(isBadStopReason("end_turn")).toBe(false);
  });
  it("dedups, polls, records batch id, harvests and fans out", async () => {
    const ledger = new InMemoryInflightLedger(),
      store = new InMemoryCacheStore(),
      req = { operation: "op", prompt: "same", maxTokens: 10 };
    await ledger.open("k", { operation: "op" });
    let polls = 0;
    const client = {
      create: vi.fn(async () => ({ id: "b" })),
      retrieve: vi.fn(async () => ({
        processing_status: polls++ ? "ended" : "in_progress",
      })),
      async *results() {
        yield {
          custom_id: "k",
          result: {
            type: "succeeded",
            message: {
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { output_tokens: 2 },
            },
          },
        };
      },
    };
    const broker = new AnthropicBatchBroker(client, store, ledger, {
      keyOf: () => "k",
      sleep: async () => {},
    });
    const out = await broker.issueBatch([req, req]);
    expect(client.create.mock.calls[0]?.[0].requests).toHaveLength(1);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(out[1]);
    expect(await ledger.markers()).toEqual([]);
  });
  it("price calculation rounds and UTC date formats", () => {
    expect(
      costUsd("claude-sonnet-4", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(18);
    expect(utcDateString(new Date("2020-01-02T23:00:00Z"))).toBe("2020-01-02");
  });
});
