import { FREE_PRICE, type ModelPrice, type SpendLedger } from "./cost.js";
import { Gateway } from "./gateway.js";
import { InMemoryInflightLedger, type InflightLedger } from "./ledger.js";
import { consoleLogger, type Logger } from "./logger.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OLLAMA_MODEL,
  createAnthropicClient,
  createBedrockClient,
  createDryRunClient,
  createOllamaClient,
  createOpenAiCompatibleClient,
  createPausedClient,
  type AnthropicClientLike,
  type BedrockClientLike,
  type FetchLike,
} from "./providers/index.js";
import {
  InMemoryCacheStore,
  NullCacheStore,
  type CacheStore,
} from "./stores/index.js";
export interface GatewayEnvDeps {
  store?: CacheStore;
  ledger?: InflightLedger;
  spendLedger?: SpendLedger;
  logger?: Logger;
  fetchImpl?: FetchLike;
  anthropicClient?: unknown;
  bedrockClient?: unknown;
  dryRunFixturesDir?: string;
  now?: () => Date;
}
export function createGatewayFromEnv(
  prefix: string,
  env: NodeJS.ProcessEnv,
  deps: GatewayEnvDeps = {},
): Gateway {
  const p = prefix.toUpperCase();
  const get = (suffix: string) => env[`${p}_${suffix}`]?.trim();
  const mode = get("LLM") || "paused";
  const modes = [
    "paused",
    "dry-run",
    "bedrock",
    "anthropic",
    "ollama",
    "openai-compatible",
  ];
  if (!modes.includes(mode))
    throw new Error(
      `${p}_LLM: unknown mode "${mode}" (expected ${modes.join("|")})`,
    );
  const cacheMode = get("LLM_CACHE") || "on";
  if (!["on", "off", "replay-only"].includes(cacheMode))
    throw new Error(
      `${p}_LLM_CACHE: unknown mode "${cacheMode}" (expected on|off|replay-only)`,
    );
  const model = get("LLM_MODEL");
  // The model actually billed and cache-keyed: what the provider will call.
  let effectiveModel = "n/a";
  let price: ModelPrice | undefined;
  const priceOverride = get("LLM_PRICE_PER_MTOK");
  if (priceOverride) {
    const m = priceOverride.match(/^\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*$/);
    if (!m)
      throw new Error(
        `${p}_LLM_PRICE_PER_MTOK must be "<input>/<output>" USD per million tokens, e.g. "3/15"`,
      );
    price = { inputPerMillionUsd: Number(m[1]), outputPerMillionUsd: Number(m[2]) };
  }
  const logger = deps.logger ?? consoleLogger;
  let provider;
  if (mode === "paused" || mode === "dry-run") price ??= FREE_PRICE;
  if (mode === "paused") provider = createPausedClient(logger);
  else if (mode === "dry-run")
    provider = createDryRunClient({
      fixturesDir: deps.dryRunFixturesDir,
      logger,
    });
  else if (mode === "bedrock") {
    const arn = get("BEDROCK_MODEL_ARN");
    if (!arn)
      throw new Error(
        `${p}_BEDROCK_MODEL_ARN is required when ${p}_LLM=bedrock`,
      );
    effectiveModel = arn;
    provider = createBedrockClient({
      modelArn: arn,
      client: deps.bedrockClient as BedrockClientLike | undefined,
      logger,
    });
  } else if (mode === "anthropic") {
    effectiveModel = model || DEFAULT_ANTHROPIC_MODEL;
    provider = createAnthropicClient({
      apiKey: env.ANTHROPIC_API_KEY,
      model: model || undefined,
      anthropicClient: deps.anthropicClient as AnthropicClientLike | undefined,
      logger,
    });
  } else if (mode === "ollama") {
    effectiveModel = model || DEFAULT_OLLAMA_MODEL;
    price ??= FREE_PRICE;
    provider = createOllamaClient({
      model: model || undefined,
      fetchImpl: deps.fetchImpl,
      logger,
    });
  } else {
    const baseUrl = get("LLM_BASE_URL"),
      apiKey = get("LLM_API_KEY");
    if (!baseUrl || !apiKey)
      throw new Error(
        `${p}_LLM_BASE_URL and ${p}_LLM_API_KEY are required when ${p}_LLM=openai-compatible`,
      );
    if (!model)
      throw new Error(
        `${p}_LLM_MODEL is required when ${p}_LLM=openai-compatible`,
      );
    effectiveModel = model;
    provider = createOpenAiCompatibleClient({
      baseUrl,
      apiKey,
      model,
      fetchImpl: deps.fetchImpl,
      logger,
    });
  }
  const daily = Number.parseFloat(get("LLM_DAILY_USD") || "10");
  if (!Number.isFinite(daily))
    throw new Error(`${p}_LLM_DAILY_USD must be a number`);
  return new Gateway({
    provider,
    model: effectiveModel,
    price,
    store:
      cacheMode === "off"
        ? new NullCacheStore()
        : (deps.store ?? new InMemoryCacheStore()),
    ledger: deps.ledger ?? new InMemoryInflightLedger(),
    spendLedger: deps.spendLedger,
    dailyCapUsd: daily,
    cacheMode: cacheMode as "on" | "off" | "replay-only",
    noBatch: get("LLM_NO_BATCH") === "1",
    forceRefresh: get("LLM_REFRESH") === "1",
    logger,
    now: deps.now,
  });
}
