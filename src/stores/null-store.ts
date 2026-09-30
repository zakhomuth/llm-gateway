import type { CacheEntry, CacheStore } from "./types.js";
export class NullCacheStore implements CacheStore {
  async get(_key: string): Promise<CacheEntry | null> {
    return null;
  }
  async put(
    _key: string,
    _entry: Omit<CacheEntry, "createdAt">,
  ): Promise<void> {}
}
