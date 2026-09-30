import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consoleLogger, type Logger } from "../logger.js";
import type { LlmClient, LlmProviderResult } from "../types.js";
export function createDryRunClient(
  options: { fixturesDir?: string; logger?: Logger } = {},
): LlmClient {
  const logger = options.logger ?? consoleLogger;
  const fixturesDir =
    options.fixturesDir ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  return {
    provider: "dry-run",
    async complete(req) {
      const fixturePath = path.join(fixturesDir, `${req.operation}.json`);
      try {
        const parsed = JSON.parse(
          await readFile(fixturePath, "utf8"),
        ) as LlmProviderResult;
        logger.log("[llm-gateway:dry-run] fixture served", {
          operation: req.operation,
          path: fixturePath,
          text: parsed.text,
        });
        return parsed;
      } catch (error) {
        logger.error("[llm-gateway:dry-run] fixture failed", {
          operation: req.operation,
          path: fixturePath,
          error,
        });
        throw error;
      }
    },
  };
}
