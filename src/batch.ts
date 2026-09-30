import { TransportFailure } from "./errors.js";
import { validateAgainstSchema } from "./gate.js";
import { requestKey } from "./key.js";
import { consoleLogger, type Logger } from "./logger.js";
import {
  buildStructuredToolParams,
  extractAnthropicMessageText,
} from "./providers/message-shape.js";
import { requestPrompt } from "./request.js";
import type { InflightLedger, InflightMarker } from "./ledger.js";
import type { CacheStore } from "./stores/types.js";
import type { LlmProviderResult, LlmRequest } from "./types.js";
export interface BatchClient {
  create(params: {
    requests: Array<{ custom_id: string; params: unknown }>;
  }): Promise<{ id: string }>;
  retrieve(
    batchId: string,
  ): Promise<{ processing_status: string; created_at?: string }>;
  results(
    batchId: string,
  ): AsyncIterable<{
    custom_id: string;
    result: {
      type: string;
      message?: {
        content: Array<{ type: string; text?: string; input?: unknown }>;
        stop_reason?: string;
        usage?: { output_tokens?: number };
      };
      error?: unknown;
    };
  }>;
}
export function isBadStopReason(reason?: string): boolean {
  return (
    reason === "pause_turn" || reason === "max_tokens" || reason === "refusal"
  );
}
export class AnthropicBatchBroker {
  private readonly pollStartMs;
  private readonly pollMaxMs;
  private readonly timeoutMs;
  private readonly sleep;
  private readonly logger;
  private readonly keyOf;
  constructor(
    private readonly client: BatchClient,
    private readonly store: CacheStore,
    private readonly ledger: InflightLedger,
    options: {
      pollStartMs?: number;
      pollMaxMs?: number;
      timeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
      logger?: Logger;
      keyOf?: (req: LlmRequest) => string;
    } = {},
  ) {
    this.pollStartMs = options.pollStartMs ?? 1000;
    this.pollMaxMs = options.pollMaxMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 7_200_000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? consoleLogger;
    // The fallback is useful for homogeneous Anthropic batches; mixed-model callers bind keyOf.
    this.keyOf =
      options.keyOf ?? ((req) => requestKey(req, "anthropic", "n/a"));
  }
  private params(req: LlmRequest): unknown {
    return {
      max_tokens: req.maxTokens,
      messages: [{ role: "user", content: requestPrompt(req) }],
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...buildStructuredToolParams(req),
    };
  }
  private async pollUntilEnded(batchId: string): Promise<void> {
    let delay = this.pollStartMs;
    let waited = 0;
    while ((await this.client.retrieve(batchId)).processing_status !== "ended") {
      if (waited + delay > this.timeoutMs)
        throw new Error(`Batch ${batchId} polling timed out`);
      await this.sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, this.pollMaxMs);
    }
  }
  private async harvest(
    batchId: string,
    markers?: Map<string, { req: LlmRequest }>,
  ): Promise<Map<string, LlmProviderResult | TransportFailure>> {
    const out = new Map<string, LlmProviderResult | TransportFailure>();
    for await (const row of this.client.results(batchId)) {
      const key = row.custom_id;
      const message = row.result.message;
      if (
        row.result.type !== "succeeded" ||
        !message ||
        isBadStopReason(message.stop_reason)
      ) {
        out.set(
          key,
          new TransportFailure(
            message?.stop_reason ?? row.result.type,
            JSON.stringify(row.result.error),
          ),
        );
        await this.ledger.close(key);
        continue;
      }
      const text = extractAnthropicMessageText(message.content);
      const req = markers?.get(key)?.req;
      if (req?.schema) {
        const validation = validateAgainstSchema(req, text, this.logger);
        if (!validation.valid) {
          this.logger.warn(
            "[llm-gateway:batch] harvested result failed schema validation; failing closed for retry",
            { batchId, key: key.slice(0, 12) },
          );
          out.set(key, new TransportFailure("schema_validation_failed"));
          await this.ledger.close(key);
          continue;
        }
      }
      const result = {
        text,
        usage: {
          inputTokens: 0,
          outputTokens: message.usage?.output_tokens ?? 0,
        },
        stopReason: message.stop_reason,
      };
      await this.store.put(key, {
        text,
        prompt: req ? requestPrompt(req) : "",
        meta: { batchId },
      });
      await this.ledger.close(key);
      out.set(key, result);
    }
    return out;
  }
  async issueBatch(
    reqs: LlmRequest[],
  ): Promise<Array<LlmProviderResult | TransportFailure>> {
    const unique = new Map<string, { req: LlmRequest }>();
    for (const req of reqs) unique.set(this.keyOf(req), { req });
    const created = await this.client.create({
      requests: [...unique].map(([custom_id, v]) => ({
        custom_id,
        params: this.params(v.req),
      })),
    });
    await Promise.all(
      [...unique.keys()].map((key) => this.ledger.setBatchId(key, created.id)),
    );
    await this.pollUntilEnded(created.id);
    const harvested = await this.harvest(created.id, unique);
    return reqs.map(
      (req) =>
        harvested.get(this.keyOf(req)) ??
        new TransportFailure("missing_result"),
    );
  }
  async adopt(batchId: string, key: string): Promise<LlmProviderResult | null> {
    const status = await this.client.retrieve(batchId);
    if (status.processing_status !== "ended" && status.created_at) {
      const age = Date.now() - new Date(status.created_at).getTime();
      if (age > this.timeoutMs)
        throw new Error(
          `batch ${batchId} stalled: still ${status.processing_status} ${Math.round(age / 1000)}s after creation (cap ${Math.round(this.timeoutMs / 1000)}s)`,
        );
    }
    if (status.processing_status !== "ended")
      await this.pollUntilEnded(batchId);
    for await (const row of this.client.results(batchId)) {
      if (row.custom_id !== key) continue;
      const message = row.result.message;
      if (row.result.type !== "succeeded" || !message) continue;
      return {
        text: extractAnthropicMessageText(message.content),
        usage: {
          inputTokens: 0,
          outputTokens: message.usage?.output_tokens ?? 0,
        },
        stopReason: message.stop_reason,
      };
    }
    this.logger.warn(
      "[llm-gateway:batch] adopt found no succeeded result; reissuing",
      {
        batchId,
        key: key.slice(0, 12),
      },
    );
    return null;
  }
  async harvestPending(): Promise<number> {
    let count = 0;
    const grouped = new Map<string, InflightMarker[]>();
    for (const marker of await this.ledger.markers())
      if (marker.batchId)
        grouped.set(marker.batchId, [
          ...(grouped.get(marker.batchId) ?? []),
          marker,
        ]);
    for (const [batchId] of grouped) {
      try {
        if ((await this.client.retrieve(batchId)).processing_status !== "ended")
          continue;
        const results = await this.harvest(batchId);
        count += results.size;
      } catch (error) {
        this.logger.error("[llm-gateway:batch] pending harvest failed", {
          batchId,
          error,
        });
      }
    }
    return count;
  }
}
