import { appendFile, open, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  PutCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { consoleLogger, type Logger } from "./logger.js";
import type { LlmUsage } from "./types.js";
export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}
// Base (non-batch, non-cache) USD per million tokens, from Anthropic's pricing
// page (2026-09-30). Keys are family patterns matched anywhere in the model
// string, longest first, so Claude API IDs ("claude-opus-5-5"), dated IDs
// ("claude-haiku-4-5-20251001") and Bedrock IDs/ARNs
// ("...us.anthropic.claude-sonnet-4-5-20250929-v1:0") all resolve.
export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-fable-5-1": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-fable-5": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-mythos-5-1": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-mythos-5": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-opus-5-5": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
  "claude-opus-5": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-8": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-7": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-6": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-5": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-1": { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  "claude-opus-4": { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  "claude-sonnet-5-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  "claude-sonnet-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  "claude-sonnet-4-6": { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  "claude-sonnet-4-5": { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  "claude-sonnet-4": { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  "claude-haiku-4-5": { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  "claude-3-5-haiku": { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 },
};
// Unknown models are priced at the most expensive listed rate so the daily cap
// errs toward stopping early rather than overspending.
export const UNKNOWN_MODEL_PRICE: ModelPrice = {
  inputPerMillionUsd: 10,
  outputPerMillionUsd: 50,
};
export const FREE_PRICE: ModelPrice = {
  inputPerMillionUsd: 0,
  outputPerMillionUsd: 0,
};
const PRICE_KEYS = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length);
export function lookupPrice(model: string): ModelPrice | undefined {
  const m = model.toLowerCase();
  const key = PRICE_KEYS.find((k) => m.includes(k));
  return key ? PRICE_TABLE[key] : undefined;
}
export function resolvePrice(model: string): ModelPrice {
  return lookupPrice(model) ?? UNKNOWN_MODEL_PRICE;
}
export function costUsd(
  model: string,
  usage: LlmUsage,
  price: ModelPrice = resolvePrice(model),
): number {
  const p = price;
  return (
    Math.round(
      ((usage.inputTokens / 1e6) * p.inputPerMillionUsd +
        (usage.outputTokens / 1e6) * p.outputPerMillionUsd) *
        1e6,
    ) / 1e6
  );
}
export interface SpendLedgerRow {
  date: string;
  operation: string;
  tenantId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export interface SpendLedger {
  record(row: SpendLedgerRow): Promise<void>;
  dailySpendUsd(date: string, tenantId?: string): Promise<number>;
}
export function utcDateString(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
export class JsonlSpendLedger implements SpendLedger {
  constructor(
    private readonly path: string,
    private readonly logger: Logger = consoleLogger,
  ) {}
  async record(row: SpendLedgerRow): Promise<void> {
    try {
      await appendFile(this.path, `${JSON.stringify(row)}\n`, "utf8");
      const h = await open(this.path, "r+");
      try {
        await h.sync();
      } finally {
        await h.close();
      }
    } catch (error) {
      this.logger.error("[llm-gateway:spend] append failed", {
        path: this.path,
        operation: row.operation,
        error,
      });
    }
  }
  async dailySpendUsd(date: string, tenantId?: string): Promise<number> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SpendLedgerRow)
        .filter(
          (r) =>
            r.date === date &&
            (tenantId === undefined || r.tenantId === tenantId),
        )
        .reduce((sum, r) => sum + r.costUsd, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.logger.warn("[llm-gateway:spend] ledger file missing", {
          path: this.path,
          date,
          tenantId,
          error,
        });
      else
        this.logger.error("[llm-gateway:spend] read failed", {
          path: this.path,
          date,
          tenantId,
          error,
        });
      return 0;
    }
  }
}
export class SqliteSpendLedger implements SpendLedger {
  constructor(
    private readonly db: Database.Database,
    private readonly tableName = "llm_spend",
    private readonly logger: Logger = consoleLogger,
  ) {
    this.ensureSchema();
  }
  ensureSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (date TEXT, operation TEXT, tenant_id TEXT, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL)`,
    );
  }
  async record(r: SpendLedgerRow): Promise<void> {
    try {
      this.db
        .prepare(`INSERT INTO ${this.tableName} VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          r.date,
          r.operation,
          r.tenantId ?? null,
          r.provider,
          r.model,
          r.inputTokens,
          r.outputTokens,
          r.costUsd,
        );
    } catch (error) {
      this.logger.error("[llm-gateway:sqlite-spend] record failed", {
        operation: r.operation,
        error,
      });
    }
  }
  async dailySpendUsd(date: string, tenantId?: string): Promise<number> {
    try {
      const sql = `SELECT COALESCE(SUM(cost_usd),0) total FROM ${this.tableName} WHERE date = ?${tenantId === undefined ? "" : " AND tenant_id = ?"}`;
      return (
        this.db
          .prepare(sql)
          .get(...(tenantId === undefined ? [date] : [date, tenantId])) as {
          total: number;
        }
      ).total;
    } catch (error) {
      this.logger.error("[llm-gateway:sqlite-spend] read failed", {
        date,
        tenantId,
        error,
      });
      return 0;
    }
  }
}
export class DynamoSpendLedger implements SpendLedger {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly logger: Logger = consoleLogger,
  ) {}
  async record(row: SpendLedgerRow): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { key: `${row.date}#${row.operation}#${randomUUID()}`, ...row },
        }),
      );
    } catch (error) {
      this.logger.error("[llm-gateway:dynamo-spend] record failed", {
        operation: row.operation,
        error,
      });
    }
  }
  async dailySpendUsd(date: string, tenantId?: string): Promise<number> {
    try {
      /* Scan is adequate here; deployments can add a date GSI. */ const out =
        await this.client.send(new ScanCommand({ TableName: this.tableName }));
      return (out.Items ?? [])
        .filter(
          (r) =>
            r.date === date &&
            (tenantId === undefined || r.tenantId === tenantId),
        )
        .reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0);
    } catch (error) {
      this.logger.error("[llm-gateway:dynamo-spend] scan failed", {
        date,
        tenantId,
        error,
      });
      return 0;
    }
  }
}
