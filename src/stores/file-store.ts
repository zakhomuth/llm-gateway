import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { consoleLogger, type Logger } from "../logger.js";
import type { CacheEntry, CacheStore } from "./types.js";

export class FileCacheStore implements CacheStore {
  constructor(
    readonly root: string,
    private readonly logger: Logger = consoleLogger,
  ) {}
  async get(key: string): Promise<CacheEntry | null> {
    try {
      const [text, raw] = await Promise.all([
        readFile(path.join(this.root, `${key}.txt`), "utf8"),
        readFile(path.join(this.root, `${key}.json`), "utf8"),
      ]);
      const meta = JSON.parse(raw) as Omit<CacheEntry, "text">;
      return { text, ...meta };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.logger.warn("[llm-gateway:file-store] cache entry missing", {
          key: key.slice(0, 12),
          error,
        });
      else
        this.logger.error("[llm-gateway:file-store] read failed", {
          key: key.slice(0, 12),
          error,
        });
      return null;
    }
  }
  async put(key: string, entry: Omit<CacheEntry, "createdAt">): Promise<void> {
    const suffix = `.tmp-${randomUUID()}`;
    const textPath = path.join(this.root, `${key}.txt`);
    const metaPath = path.join(this.root, `${key}.json`);
    const textTmp = textPath + suffix;
    const metaTmp = metaPath + suffix;
    try {
      await mkdir(this.root, { recursive: true });
      const createdAt = new Date().toISOString();
      await writeFile(textTmp, entry.text, "utf8");
      await writeFile(
        metaTmp,
        JSON.stringify({ prompt: entry.prompt, meta: entry.meta, createdAt }),
        "utf8",
      );
      await rename(textTmp, textPath);
      await rename(metaTmp, metaPath);
    } catch (error) {
      this.logger.error("[llm-gateway:file-store] write failed", {
        key: key.slice(0, 12),
        error,
      });
    }
  }
}
