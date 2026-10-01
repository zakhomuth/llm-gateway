import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Gateway,
  InMemoryCacheStore,
  InMemoryInflightLedger,
} from "../index.js";

const request = {
  operation: "validate",
  prompt: "Return a name.",
  maxTokens: 10,
  schema: z.object({ name: z.string() }),
};

describe("validation retries", () => {
  it("testValidationRetryCorrectsAndRecordsEveryAttempt", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        text: "not json",
        usage: { inputTokens: 1, outputTokens: 2 },
      })
      .mockResolvedValueOnce({
        text: '{"name":"fixed"}',
        usage: { inputTokens: 3, outputTokens: 4 },
      });
    const record = vi.fn(async () => {});
    const gateway = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
      spendLedger: { record, dailySpendUsd: async () => 0 },
    });

    expect(
      (await gateway.complete({ ...request, validationRetries: 1 })).parsed,
    ).toEqual({ name: "fixed" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].messages).toEqual([
      { role: "user", content: "Return a name." },
      { role: "assistant", content: "not json" },
      {
        role: "user",
        content:
          "Validation failed: response is not valid JSON. Return a corrected result that satisfies the schema.",
      },
    ]);
  });

  it("testValidationRetriesDefaultsToZero", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        text: "not json",
        usage: { inputTokens: 1, outputTokens: 2 },
      })
      .mockResolvedValueOnce({
        text: '{"name":"fixed"}',
        usage: { inputTokens: 3, outputTokens: 4 },
      });
    const gateway = new Gateway({
      provider: { provider: "fake", complete },
      model: "m",
      store: new InMemoryCacheStore(),
      ledger: new InMemoryInflightLedger(),
    });

    expect((await gateway.complete(request)).parsed).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
  });
});
