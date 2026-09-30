import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoCacheStore,
  DynamoSpendLedger,
  JsonlSpendLedger,
  SqliteCacheStore,
  SqliteSpendLedger,
  utcDateString,
} from "../index.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("persistent stores and spend ledgers", () => {
  it("testSqliteStoreRoundTrip", async () => {
    const db = new Database(":memory:");
    const store = new SqliteCacheStore(db);
    await store.put("key", {
      text: "value",
      prompt: "full prompt",
      meta: { nested: true },
    });
    expect(await store.get("key")).toMatchObject({
      text: "value",
      prompt: "full prompt",
      meta: { nested: true },
    });
    db.close();
  });

  it("testSqliteSpendLedgerSumsAndFiltersTenant", async () => {
    const db = new Database(":memory:");
    const ledger = new SqliteSpendLedger(db);
    const base = {
      date: "2026-09-30",
      operation: "op",
      provider: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
    };
    await ledger.record({ ...base, tenantId: "a", costUsd: 1.25 });
    await ledger.record({ ...base, tenantId: "b", costUsd: 2.5 });
    await ledger.record({ ...base, costUsd: 4 });
    expect(await ledger.dailySpendUsd(base.date)).toBe(7.75);
    expect(await ledger.dailySpendUsd(base.date, "a")).toBe(1.25);
    db.close();
  });

  it("testDynamoStoreRoundTripPreservesJsonMeta", async () => {
    const items = new Map<string, Record<string, unknown>>();
    const client = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name === "PutCommand") {
          items.set(command.input.Item.key, command.input.Item);
          return {};
        }
        return { Item: items.get(command.input.Key.key) };
      }),
    };
    const store = new DynamoCacheStore(client as never, "cache");
    await store.put("key", {
      text: "answer",
      prompt: "prompt",
      meta: { x: ["y"] },
    });
    expect(await store.get("key")).toMatchObject({
      text: "answer",
      prompt: "prompt",
      meta: { x: ["y"] },
    });
    expect(typeof items.get("key")?.meta).toBe("string");
  });

  it("testDynamoStoreToleratesObjectMeta", async () => {
    const client = {
      send: async () => ({
        Item: {
          text: "t",
          prompt: "p",
          meta: { already: "object" },
          createdAt: "now",
        },
      }),
    };
    expect(
      await new DynamoCacheStore(client as never, "cache").get("key"),
    ).toMatchObject({ meta: { already: "object" } });
  });

  it("testJsonlSpendLedgerRecordsAndFilters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spend-"));
    const ledger = new JsonlSpendLedger(path.join(root, "spend.jsonl"));
    const base = {
      date: "2026-09-30",
      operation: "op",
      provider: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
    };
    await ledger.record({ ...base, tenantId: "a", costUsd: 1 });
    await ledger.record({ ...base, tenantId: "b", costUsd: 2 });
    expect(await ledger.dailySpendUsd(base.date)).toBe(3);
    expect(await ledger.dailySpendUsd(base.date, "a")).toBe(1);
  });

  it("testJsonlSpendLedgerMissingFileIsZero", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spend-"));
    expect(
      await new JsonlSpendLedger(path.join(root, "missing")).dailySpendUsd(
        "2026-09-30",
      ),
    ).toBe(0);
  });

  it("testDynamoSpendLedgerRecordsAndScans", async () => {
    const items: Record<string, unknown>[] = [];
    const client = {
      send: async (command: any) =>
        command.constructor.name === "PutCommand"
          ? (items.push(command.input.Item), {})
          : { Items: items },
    };
    const ledger = new DynamoSpendLedger(client as never, "spend");
    const row = {
      date: "2026-09-30",
      operation: "op",
      tenantId: "a",
      provider: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1.5,
    };
    await ledger.record(row);
    expect(await ledger.dailySpendUsd(row.date, "a")).toBe(1.5);
    expect(String(items[0]?.key)).toContain("2026-09-30#op#");
  });

  it("testUtcDateStringUsesUtc", () =>
    expect(utcDateString(new Date("2026-09-30T23:59:59-04:00"))).toBe(
      "2026-10-01",
    ));
});
