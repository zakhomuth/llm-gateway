import type { LlmRequest } from "./types.js";
import { consoleLogger, type Logger } from "./logger.js";
export function validateAgainstSchema(
  req: LlmRequest,
  text: string,
  logger: Logger = consoleLogger,
): { valid: boolean; parsed?: unknown } {
  if (!req.schema) return { valid: true };
  try {
    const result = req.schema.safeParse(JSON.parse(text));
    return result.success
      ? { valid: true, parsed: result.data }
      : { valid: false };
  } catch (error) {
    logger.warn(
      "[llm-gateway] response is not valid JSON for schema validation",
      { operation: req.operation, error },
    );
    return { valid: false };
  }
}
export function cacheable(
  req: LlmRequest,
  result: { text: string; stopReason?: string },
  logger: Logger = consoleLogger,
): { ok: boolean; parsed?: unknown } {
  if (!result.text.trim()) return { ok: false };
  if (result.text.includes("Credit balance is too low")) return { ok: false };
  if (result.stopReason === "max_tokens" || result.stopReason === "refusal")
    return { ok: false };
  const validation = validateAgainstSchema(req, result.text, logger);
  return validation.valid
    ? { ok: true, parsed: validation.parsed }
    : { ok: false };
}
