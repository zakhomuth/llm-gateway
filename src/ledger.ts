import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { consoleLogger, type Logger } from "./logger.js";
export interface InflightMarker {
  key: string;
  pid: number;
  startedAt: number;
  operation?: string;
  batchId?: string;
}
export interface InflightLedger {
  open(key: string, meta: { operation?: string }): Promise<void>;
  setBatchId(key: string, batchId: string): Promise<void>;
  close(key: string): Promise<void>;
  read(key: string): Promise<InflightMarker | null>;
  markers(): Promise<InflightMarker[]>;
}
export class InMemoryInflightLedger implements InflightLedger {
  private data = new Map<string, InflightMarker>();
  async open(key: string, meta: { operation?: string }): Promise<void> {
    this.data.set(key, {
      key,
      pid: process.pid,
      startedAt: Date.now(),
      ...meta,
    });
  }
  async setBatchId(key: string, batchId: string): Promise<void> {
    const m = this.data.get(key);
    if (m) m.batchId = batchId;
  }
  async close(key: string): Promise<void> {
    this.data.delete(key);
  }
  async read(key: string): Promise<InflightMarker | null> {
    return this.data.get(key) ?? null;
  }
  async markers(): Promise<InflightMarker[]> {
    return [...this.data.values()];
  }
}
export class FileInflightLedger implements InflightLedger {
  private readonly dir: string;
  constructor(
    root: string,
    private readonly logger: Logger = consoleLogger,
  ) {
    this.dir = path.join(root, "inflight");
  }
  private file(key: string) {
    return path.join(this.dir, `${key}.json`);
  }
  private async write(marker: InflightMarker) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(marker.key)}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(marker));
    await rename(tmp, this.file(marker.key));
  }
  async open(key: string, meta: { operation?: string }): Promise<void> {
    await this.write({ key, pid: process.pid, startedAt: Date.now(), ...meta });
  }
  async setBatchId(key: string, batchId: string): Promise<void> {
    const m = await this.read(key);
    if (m) await this.write({ ...m, batchId });
  }
  async close(key: string): Promise<void> {
    try {
      await unlink(this.file(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.logger.warn("[llm-gateway:ledger] marker already closed", {
          key: key.slice(0, 12),
          error,
        });
      else
        this.logger.error("[llm-gateway:ledger] close failed", {
          key: key.slice(0, 12),
          error,
        });
    }
  }
  async read(key: string): Promise<InflightMarker | null> {
    try {
      return JSON.parse(
        await readFile(this.file(key), "utf8"),
      ) as InflightMarker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.logger.warn("[llm-gateway:ledger] marker missing", {
          key: key.slice(0, 12),
          error,
        });
      else
        this.logger.error("[llm-gateway:ledger] read failed", {
          key: key.slice(0, 12),
          error,
        });
      return null;
    }
  }
  async markers(): Promise<InflightMarker[]> {
    try {
      const names = await readdir(this.dir);
      const values = await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .map((n) => this.read(n.slice(0, -5))),
      );
      return values.filter((v): v is InflightMarker => v !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.logger.warn("[llm-gateway:ledger] marker directory missing", {
          error,
        });
      else this.logger.error("[llm-gateway:ledger] list failed", { error });
      return [];
    }
  }
}
export function holderAlive(marker: InflightMarker): boolean {
  if (marker.pid <= 0) return false;
  try {
    process.kill(marker.pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function reportStale(
  markers: InflightMarker[],
  logger: Logger = consoleLogger,
): void {
  for (const marker of markers)
    if (!holderAlive(marker))
      marker.batchId
        ? logger.warn("[llm-gateway] recoverable stale batch marker", {
            key: marker.key,
            batchId: marker.batchId,
          })
        : logger.error("[llm-gateway] paid-but-lost stale call", {
            key: marker.key,
          });
}
