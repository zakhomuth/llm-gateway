import type { CacheEntry, CacheStore } from "./types.js";
export class InMemoryCacheStore implements CacheStore {
  private readonly data = new Map<string, CacheEntry>();
  async get(key: string): Promise<CacheEntry | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, entry: Omit<CacheEntry, "createdAt">): Promise<void> {
    this.data.set(key, { ...entry, createdAt: new Date().toISOString() });
  }
}
