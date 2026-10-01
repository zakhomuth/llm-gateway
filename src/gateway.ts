import { checkDailyBudget } from "./budget.js";
import { costUsd, lookupPrice, UNKNOWN_MODEL_PRICE, utcDateString, type ModelPrice, type SpendLedger } from "./cost.js";
import { deferredShutdown, shutdownPending } from "./drain.js";
import {
  LlmPausedError,
  ShutdownRequestedError,
  TransportFailure,
  isLlmPausedError,
} from "./errors.js";
import { cacheable, validateAgainstSchema } from "./gate.js";
import { requestKey } from "./key.js";
import { holderAlive, type InflightLedger } from "./ledger.js";
import { consoleLogger, type Logger } from "./logger.js";
import { requestPrompt, resolveMessages, validateRequest } from "./request.js";
import type { CacheStore } from "./stores/types.js";
import type {
  LlmClient,
  LlmProviderResult,
  LlmRequest,
  LlmResult,
} from "./types.js";
export interface GatewayOptions {
  provider: LlmClient;
  store: CacheStore;
  ledger: InflightLedger;
  model: string;
  /** Per-million-token price; defaults to the PRICE_TABLE entry for `model`. */
  price?: ModelPrice;
  keyOf?: (req: LlmRequest) => string;
  issueBatch?: (
    reqs: LlmRequest[],
  ) => Promise<Array<LlmProviderResult | TransportFailure>>;
  spendLedger?: SpendLedger;
  dailyCapUsd?: number;
  tenantId?: string;
  transportRetryBound?: number;
  noBatch?: boolean;
  cacheMode?: "on" | "off" | "replay-only";
  logger?: Logger;
  forceRefresh?: boolean;
  now?: () => Date;
  adoptBatch?: (
    batchId: string,
    key: string,
  ) => Promise<LlmProviderResult | null>;
  resend?: (pid: number, signal: NodeJS.Signals) => void;
  holderWaitMs?: number;
  holderPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
export class Gateway {
  private readonly provider;
  private readonly store;
  private readonly ledger;
  private readonly model;
  private readonly price: ModelPrice;
  private readonly keyOf;
  private readonly issueBatch?;
  private readonly spendLedger?;
  private readonly dailyCapUsd?;
  private readonly tenantId?;
  private readonly retryBound;
  private readonly noBatch;
  private readonly cacheMode;
  private readonly logger;
  private readonly forceRefresh;
  private readonly now;
  private readonly adoptBatch?: GatewayOptions["adoptBatch"];
  private readonly resend?: GatewayOptions["resend"];
  private readonly holderWaitMs: number;
  private readonly holderPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly directKeys = new Set<string>();
  constructor(o: GatewayOptions) {
    this.provider = o.provider;
    this.store = o.store;
    this.ledger = o.ledger;
    this.model = o.model;
    const known = lookupPrice(o.model);
    this.price = o.price ?? known ?? UNKNOWN_MODEL_PRICE;
    if (!o.price && !known)
      (o.logger ?? consoleLogger).warn(
        "[llm-gateway] no price for model; costing at the highest listed rate",
        { model: o.model, price: UNKNOWN_MODEL_PRICE },
      );
    this.keyOf =
      o.keyOf ?? ((r) => requestKey(r, o.provider.provider, o.model));
    this.issueBatch = o.issueBatch;
    this.spendLedger = o.spendLedger;
    this.dailyCapUsd = o.dailyCapUsd;
    this.tenantId = o.tenantId;
    this.retryBound = o.transportRetryBound ?? 2;
    this.noBatch = o.noBatch ?? false;
    this.cacheMode = o.cacheMode ?? "on";
    this.logger = o.logger ?? consoleLogger;
    this.forceRefresh = o.forceRefresh ?? false;
    this.now = o.now ?? (() => new Date());
    this.adoptBatch = o.adoptBatch;
    this.resend = o.resend;
    this.holderWaitMs = o.holderWaitMs ?? 900_000;
    this.holderPollMs = o.holderPollMs ?? 5_000;
    this.sleep =
      o.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }
  private prepared(req: LlmRequest): LlmRequest {
    validateRequest(req);
    return this.forceRefresh ? { ...req, fresh: true } : req;
  }
  private async hit(req: LlmRequest, key: string): Promise<LlmResult | null> {
    if (req.fresh) return null;
    const entry = await this.store.get(key);
    if (!entry) return null;
    const validation = validateAgainstSchema(req, entry.text, this.logger);
    if (!validation.valid) {
      this.logger.warn(
        `[llm-gateway] cached entry ${key.slice(0, 12)} no longer validates against schema; reissuing`,
        { operation: req.operation, key: key.slice(0, 12) },
      );
      return null;
    }
    this.logger.log("[llm-gateway] cache hit", {
      operation: req.operation,
      key: key.slice(0, 12),
    });
    return {
      text: entry.text,
      parsed: validation.parsed,
      usage: { inputTokens: 0, outputTokens: 0 },
      cached: true,
      costUsd: 0,
    };
  }
  private async recordCost(
    req: LlmRequest,
    result: LlmProviderResult,
  ): Promise<void> {
    if (!this.spendLedger) return;
    await this.spendLedger.record({
      date: utcDateString(this.now()),
      operation: req.operation,
      tenantId: req.tenantId ?? this.tenantId,
      provider: this.provider.provider,
      model: this.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: costUsd(this.model, result.usage, this.price),
    });
  }
  private async tryAdopt(
    req: LlmRequest,
    key: string,
  ): Promise<LlmResult | null> {
    const marker = await this.ledger.read(key);
    if (!marker) return null;
    if (marker.batchId) {
      if (!this.adoptBatch) return null;
      try {
        const raw = await this.adoptBatch(marker.batchId, key);
        if (!raw) {
          await this.ledger.close(key);
          return null;
        }
        const gate = cacheable(req, raw, this.logger);
        if (!gate.ok) {
          this.logger.warn(
            "[llm-gateway] adopted batch result failed validation; reissuing",
            {
              operation: req.operation,
              key: key.slice(0, 12),
              batchId: marker.batchId,
            },
          );
          await this.ledger.close(key);
          return null;
        }
        await this.recordCost(req, raw);
        await this.store.put(key, {
          text: raw.text,
          prompt: requestPrompt(req),
          meta: {
            operation: req.operation,
            provider: this.provider.provider,
            model: this.model,
            adoptedFrom: marker.batchId,
          },
        });
        await this.ledger.close(key);
        this.logger.log("[llm-gateway] adopted batch result", {
          operation: req.operation,
          key: key.slice(0, 12),
          batchId: marker.batchId,
        });
        return this.result(req, raw, gate.parsed);
      } catch (error) {
        this.logger.warn(
          "[llm-gateway] batch adoption timed out; reissuing direct",
          {
            operation: req.operation,
            key: key.slice(0, 12),
            batchId: marker.batchId,
            error,
          },
        );
        await this.ledger.close(key);
        this.directKeys.add(key);
        return null;
      }
    }
    if (!holderAlive(marker)) {
      this.logger.warn("[llm-gateway] stale sync marker taken over", {
        operation: req.operation,
        key: key.slice(0, 12),
        pid: marker.pid,
      });
      await this.ledger.close(key);
      return null;
    }
    return this.waitForHolder(req, key);
  }
  private async waitForHolder(
    req: LlmRequest,
    key: string,
  ): Promise<LlmResult | null> {
    this.logger.warn(
      "[llm-gateway] key in flight in another process; waiting for its cache write",
      { operation: req.operation, key: key.slice(0, 12) },
    );
    const deadline = Date.now() + this.holderWaitMs;
    while (Date.now() < deadline) {
      await this.sleep(this.holderPollMs);
      const hit = await this.hit(req, key);
      if (hit) return hit;
      const current = await this.ledger.read(key);
      if (!current || !holderAlive(current)) return null;
    }
    this.logger.warn(
      "[llm-gateway] gave up waiting on holder; issuing own call",
      {
        operation: req.operation,
        key: key.slice(0, 12),
      },
    );
    return null;
  }
  private result(
    req: LlmRequest,
    r: LlmProviderResult,
    parsed?: unknown,
  ): LlmResult {
    return {
      text: r.text,
      parsed,
      usage: r.usage,
      cached: false,
      costUsd: costUsd(this.model, r.usage, this.price),
      stopReason: r.stopReason,
    };
  }
  /** Name of the active provider ("paused", "dry-run", "bedrock", …). */
  get providerName(): string {
    return this.provider.provider;
  }

  async complete(input: LlmRequest): Promise<LlmResult> {
    const req = this.prepared(input);
    const key = this.keyOf(req);
    const hit = await this.hit(req, key);
    if (hit) return hit;
    if (this.cacheMode === "replay-only") {
      this.logger.warn("[llm-gateway] replay-only cache miss", {
        operation: req.operation,
        key: key.slice(0, 12),
      });
      throw new LlmPausedError(
        `LLM operation "${req.operation}" blocked by replay-only cache mode`,
      );
    }
    if (shutdownPending()) throw new ShutdownRequestedError();
    const tenant = req.tenantId ?? this.tenantId;
    if (this.spendLedger && this.dailyCapUsd !== undefined)
      await checkDailyBudget(
        this.spendLedger,
        this.dailyCapUsd,
        tenant,
        this.logger,
        this.now(),
      );
    const adopted = await this.tryAdopt(req, key);
    if (adopted) return adopted;
    return deferredShutdown(
      async () => {
        await this.ledger.open(key, { operation: req.operation });
        const callProvider = async (
          request: LlmRequest,
        ): Promise<LlmProviderResult> => {
          let attempt = 0;
          for (;;) {
            try {
              return await this.provider.complete(request);
            } catch (error) {
              if (isLlmPausedError(error)) {
                await this.ledger.close(key);
                throw error;
              }
              attempt++;
              if (attempt > this.retryBound) {
                this.logger.error("[llm-gateway] transport retries exhausted", {
                  operation: req.operation,
                  key: key.slice(0, 12),
                  provider: this.provider.provider,
                  error,
                });
                await this.ledger.close(key);
                throw error;
              }
              this.logger.warn("[llm-gateway] retrying transport failure", {
                operation: req.operation,
                key: key.slice(0, 12),
                provider: this.provider.provider,
                attempt,
                error,
              });
            }
          }
        };
        let requestToSend = req;
        let validationAttempt = 0;
        let result: LlmProviderResult;
        let gate: ReturnType<typeof cacheable>;
        for (;;) {
          result = await callProvider(requestToSend);
          await this.recordCost(req, result);
          gate = cacheable(req, result, this.logger);
          if (
            gate.ok ||
            !req.schema ||
            validationAttempt >= (req.validationRetries ?? 0)
          )
            break;
          let summary: string;
          try {
            const validation = req.schema.safeParse(JSON.parse(result.text));
            summary = validation.success
              ? "response failed validation"
              : validation.error.issues
                  .map(
                    (issue) =>
                      `${issue.path.join(".")}: ${issue.message}`,
                  )
                  .join("; ");
          } catch (error) {
            summary = "response is not valid JSON";
            this.logger.error(
              "[llm-gateway] could not parse response for validation retry",
              { operation: req.operation, key: key.slice(0, 12), error },
            );
          }
          summary = summary.slice(0, 2000);
          validationAttempt++;
          this.logger.warn(
            "[llm-gateway] validation failed; retrying with correction",
            {
              operation: req.operation,
              key: key.slice(0, 12),
              attempt: validationAttempt,
              issues: summary,
            },
          );
          requestToSend = {
            ...req,
            prompt: undefined,
            messages: [
              ...resolveMessages(req),
              { role: "assistant", content: result.text },
              {
                role: "user",
                content:
                  "Validation failed: " +
                  summary +
                  ". Return a corrected result that satisfies the schema.",
              },
            ],
          };
        }
        if (gate.ok)
          await this.store.put(key, {
            text: result.text,
            prompt: requestPrompt(req),
            meta: {
              operation: req.operation,
              provider: this.provider.provider,
              model: this.model,
            },
          });
        await this.ledger.close(key);
        this.logger.log("[llm-gateway] miss complete", {
          operation: req.operation,
          key: key.slice(0, 12),
          provider: this.provider.provider,
          prompt: requestPrompt(req),
          response: result.text,
        });
        return this.result(req, result, gate.parsed);
      },
      { resend: this.resend },
    );
  }
  async completeMany(inputs: LlmRequest[]): Promise<Array<LlmResult | null>> {
    const reqs = inputs.map((r) => this.prepared(r));
    const results: Array<LlmResult | null> = Array(reqs.length).fill(null);
    const misses: Array<{ req: LlmRequest; i: number; key: string }> = [];
    for (let i = 0; i < reqs.length; i++) {
      const req = reqs[i]!;
      const key = this.keyOf(req);
      const hit = await this.hit(req, key);
      if (hit) results[i] = hit;
      else misses.push({ req, i, key });
    }
    const batched =
      this.issueBatch && !this.noBatch
        ? misses.filter(
            (x) => x.req.batchable !== false && !this.directKeys.has(x.key),
          )
        : [];
    const batchIndexes = new Set(batched.map((x) => x.i));
    if (batched.length && this.issueBatch) {
      for (const x of batched)
        await this.ledger.open(x.key, { operation: x.req.operation });
      const responses = await this.issueBatch(batched.map((x) => x.req));
      for (let j = 0; j < batched.length; j++) {
        const x = batched[j]!;
        const response = responses[j]!;
        if (response instanceof TransportFailure) {
          try {
            // Batch brokers normally clear failed markers while harvesting.
            // Close defensively for custom brokers before the direct fallback.
            await this.ledger.close(x.key);
            results[x.i] = await this.complete({ ...x.req, fresh: true });
          } catch (error) {
            this.logger.error(
              "[llm-gateway] transport failure after batch + single retries — NOT written",
              { operation: x.req.operation, key: x.key.slice(0, 12), error },
            );
            await this.ledger.close(x.key);
            results[x.i] = null;
          }
          continue;
        }
        await this.recordCost(x.req, response);
        const gate = cacheable(x.req, response, this.logger);
        if (gate.ok)
          await this.store.put(x.key, {
            text: response.text,
            prompt: requestPrompt(x.req),
            meta: {
              operation: x.req.operation,
              provider: this.provider.provider,
              model: this.model,
            },
          });
        await this.ledger.close(x.key);
        results[x.i] = this.result(x.req, response, gate.parsed);
      }
    }
    for (const x of misses)
      if (!batchIndexes.has(x.i)) results[x.i] = await this.complete(x.req);
    return results;
  }
}
export { cacheable, validateAgainstSchema } from "./gate.js";
