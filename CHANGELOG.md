# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
