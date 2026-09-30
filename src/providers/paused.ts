import { LlmPausedError } from "../errors.js";
import { consoleLogger, type Logger } from "../logger.js";
import type { LlmClient } from "../types.js";
export function createPausedClient(logger: Logger = consoleLogger): LlmClient {
  return {
    provider: "paused",
    async complete(req) {
      logger.warn("[llm-gateway:paused] skipped model call", {
        operation: req.operation,
      });
      throw new LlmPausedError(
        `LLM calls are paused; skipped operation "${req.operation}"`,
      );
    },
  };
}
