export interface CacheEntry {
  text: string;
  prompt: string;
  meta: Record<string, unknown>;
  createdAt: string;
}
export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  put(key: string, entry: Omit<CacheEntry, "createdAt">): Promise<void>;
}
