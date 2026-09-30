import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { CacheEntry, CacheStore } from "./types.js";
export class DynamoCacheStore implements CacheStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async get(key: string): Promise<CacheEntry | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { key } }),
    );
    if (!out.Item) return null;
    const meta =
      typeof out.Item.meta === "string"
        ? JSON.parse(out.Item.meta)
        : out.Item.meta;
    return {
      text: out.Item.text,
      prompt: out.Item.prompt,
      meta,
      createdAt: out.Item.createdAt,
    };
  }
  async put(key: string, entry: Omit<CacheEntry, "createdAt">): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          key,
          text: entry.text,
          prompt: entry.prompt,
          meta: JSON.stringify(entry.meta),
          createdAt: new Date().toISOString(),
        },
      }),
    );
  }
}
