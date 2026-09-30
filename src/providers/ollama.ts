import { consoleLogger, type Logger } from "../logger.js";
import { resolveMessages, requestPrompt } from "../request.js";
import type { LlmClient, LlmRequest } from "../types.js";
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export const DEFAULT_OLLAMA_MODEL = "llama3";
export function createOllamaClient(
  options: {
    baseUrl?: string;
    model?: string;
    fetchImpl?: FetchLike;
    logger?: Logger;
  } = {},
): LlmClient {
  const logger = options.logger ?? consoleLogger;
  const baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(
    /\/+$/,
    "",
  );
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: "ollama",
    async complete(req: LlmRequest) {
      const messages: Array<Record<string, unknown>> = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...resolveMessages(req),
      ];
      if (req.images?.length)
        messages[messages.length - 1]!.images = req.images.map((i) => i.data);
      const body = {
        model,
        messages,
        stream: false,
        options: {
          num_predict: req.maxTokens,
          ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
        },
      };
      logger.log("[llm-gateway:ollama] request", {
        operation: req.operation,
        model,
        prompt: requestPrompt(req),
        body,
      });
      try {
        const response = await fetchImpl(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const raw = await response.text();
        if (!response.ok)
          throw new Error(
            `Ollama request failed with status ${response.status}: ${raw}`,
          );
        const parsed = JSON.parse(raw) as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
          done_reason?: string;
        };
        if (typeof parsed.message?.content !== "string")
          throw new Error("Ollama response has no message.content");
        logger.log("[llm-gateway:ollama] response", {
          operation: req.operation,
          model,
          text: parsed.message.content,
        });
        return {
          text: parsed.message.content,
          usage: {
            inputTokens: parsed.prompt_eval_count ?? 0,
            outputTokens: parsed.eval_count ?? 0,
          },
          stopReason: parsed.done_reason,
        };
      } catch (error) {
        logger.error("[llm-gateway:ollama] request failed", {
          operation: req.operation,
          model,
          error,
        });
        throw error;
      }
    },
  };
}
