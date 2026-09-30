// better-sqlite3 is optional so consumers using another store do not install its native binding.
import type Database from "better-sqlite3";
import type { CacheEntry, CacheStore } from "./types.js";

export class SqliteCacheStore implements CacheStore {
  constructor(
    private readonly db: Database.Database,
    private readonly tableName = "llm_cache",
  ) {
    this.ensureSchema();
  }
  ensureSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (key TEXT PRIMARY KEY, text TEXT NOT NULL, prompt TEXT NOT NULL, meta TEXT NOT NULL, created_at TEXT NOT NULL)`,
    );
  }
  async get(key: string): Promise<CacheEntry | null> {
    const row = this.db
      .prepare(
        `SELECT text, prompt, meta, created_at FROM ${this.tableName} WHERE key = ?`,
      )
      .get(key) as
      | { text: string; prompt: string; meta: string; created_at: string }
      | undefined;
    return row
      ? {
          text: row.text,
          prompt: row.prompt,
          meta: JSON.parse(row.meta),
          createdAt: row.created_at,
        }
      : null;
  }
  async put(key: string, entry: Omit<CacheEntry, "createdAt">): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.tableName} (key,text,prompt,meta,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(
        key,
        entry.text,
        entry.prompt,
        JSON.stringify(entry.meta),
        new Date().toISOString(),
      );
  }
}
