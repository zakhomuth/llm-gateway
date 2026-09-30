# @zakhomuth/llm-gateway

```ts
import { createGatewayFromEnv } from '@zakhomuth/llm-gateway';

const gateway = createGatewayFromEnv('APP', process.env);
const result = await gateway.complete({ operation: 'summarize', prompt: 'Summarize this.', maxTokens: 512 });
```

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `<P>_LLM` | `paused`, `dry-run`, `bedrock`, `anthropic`, `ollama`, or `openai-compatible` | `paused` |
| `<P>_LLM_MODEL` | Provider model identifier (required for `openai-compatible`; bedrock uses `<P>_BEDROCK_MODEL_ARN`) | `claude-sonnet-5-5` (anthropic), `llama3` (ollama) |
| `<P>_BEDROCK_MODEL_ARN` | Bedrock inference profile ARN | required for Bedrock |
| `<P>_LLM_BASE_URL` | OpenAI-compatible base URL | required in that mode |
| `<P>_LLM_API_KEY` | OpenAI-compatible bearer token | required in that mode |
| `<P>_LLM_CACHE` | `on`, `off`, or `replay-only` | `on` |
| `<P>_LLM_DAILY_USD` | Daily USD cap | `10` |
| `<P>_LLM_PRICE_PER_MTOK` | `<input>/<output>` USD per million tokens, e.g. `3/15`; overrides the built-in table | built-in Claude table; ollama, paused and dry-run cost `0` |
| `<P>_LLM_REFRESH` | `1` bypasses cache reads | unset |
| `<P>_LLM_NO_BATCH` | `1` disables batching | unset |

Cache mode `on` reads and writes entries. `off` uses a null store. `replay-only` serves hits and rejects misses. Provider modes select the corresponding adapter; paused rejects calls and dry-run reads operation-named fixtures.

## Cross-process ledger adoption

`FileInflightLedger` markers are readable by any process pointed at the same
store root, which makes them cross-process by construction — `Gateway`
adopts an existing marker before opening a new one: a marker with a
`batchId` is handed to the injected `adoptBatch(batchId, key)` callback
(never resubmitted as a new batch); a sync marker whose holder pid is dead
is taken over immediately, and a live holder is polled for up to
`holderWaitMs` (default 15 minutes) before giving up and issuing a fresh
call. A batch adoption that raises (the batch is stalled past its own
polling cap) marks the key direct-only for the remainder of that `Gateway`
instance's `completeMany` batching decisions, so it never loops into another
orphaned batch. `InflightLedger` is a plain interface, so a DynamoDB-backed
implementation can be added later without touching `Gateway`.

`autoTool?: boolean` on `LlmRequest` selects Anthropic's `tool_choice: auto`
for structured (schema) calls instead of the default forced tool choice —
some models reject a forced tool_choice. It is folded into the cache key and
supported by both the direct Anthropic provider and `AnthropicBatchBroker`.

## Store schemas

The file store writes `<root>/<key>.txt` and `<root>/<key>.json`; the sidecar contains `prompt`, `meta`, and `createdAt`.

```sql
CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, text TEXT NOT NULL, prompt TEXT NOT NULL, meta TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS llm_spend (date TEXT, operation TEXT, tenant_id TEXT, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL);
```

The DynamoDB cache table uses partition key `key` (string). Cache items contain `text`, `prompt`, JSON-string `meta`, and `createdAt`. Spend items use `key = date#operation#uuid`; daily totals currently use a scan.

## Cost

Spend is computed from provider-reported token usage. Claude models are priced from a built-in table (`PRICE_TABLE`,
base per-million-token rates) that matches Claude API IDs, dated IDs and Bedrock IDs/ARNs by model family. A model the
table does not know is costed at the highest listed rate and logs a warning once, so the daily cap errs on the safe side;
set `<P>_LLM_PRICE_PER_MTOK` for `openai-compatible` or custom models.
