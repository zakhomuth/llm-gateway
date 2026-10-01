# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.2.2

- Ollama reads its base URL from `<P>_LLM_BASE_URL` (default `http://localhost:11434`), so docker can reach a host Ollama.
- Anthropic reads `<P>_LLM_API_KEY` before falling back to `ANTHROPIC_API_KEY`.
- `createGatewayFromEnv` deps accept `transportRetryBound` (0 = a single attempt).
- `Gateway.providerName` exposes the active provider ("paused", "dry-run", "bedrock", …).

## 0.2.1

- Structured-output JSON schemas now cover unions (incl. discriminated), intersections, records/maps, tuples, sets,
  defaults, refinements/transforms, pipelines, lazy, nullish, `int()`, dates and `any`/`unknown`; previously these
  became invalid types such as `{"type":"union"}`.
- `.describe()` text is kept on every type, not only strings.
- Cache keys for schema requests that use these types change once.
- Provider request logs truncate strings over 10k chars (base64 attachments) to 200 chars plus their length; prompts
  are still logged in full.

## 0.2.0

- Added PDF/document attachments through the `LlmAttachment` alias: `application/pdf` becomes a document content block for Anthropic and Bedrock, while Ollama and OpenAI-compatible providers return an explicit unsupported error.
- Placed attachments before text and attached them to the first user message even when `messages` is given.
- Added non-object root schema support for structured output through automatic object wrapping and transparent unwrapping with `isWrappedSchema`.
- Added the `validationRetries` request option to retry schema-validation failures with a correction turn.
- Confirmed and tested provider error message passthrough.
- Bedrock driver now sends the structured-output tool for schema requests (forced or autoTool) and reads the tool input; previously it read text only.
- Schema requests prefer the tool input over any text preamble.

## 0.1.0

- Initial release: paused/dry-run/replay modes, Anthropic/Bedrock/Ollama/OpenAI-compatible providers, response cache, spend ledger, daily USD cap.
