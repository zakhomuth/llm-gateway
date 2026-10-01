import { zodShape } from "../key.js";
import { consoleLogger, type Logger } from "../logger.js";
import { resolveMessages, requestPrompt } from "../request.js";
import type { LlmClient, LlmRequest } from "../types.js";
import type { FetchLike } from "./ollama.js";
export function createOpenAiCompatibleClient(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  logger?: Logger;
}): LlmClient {
  const logger = options.logger ?? consoleLogger;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  return {
    provider: "openai-compatible",
    async complete(req: LlmRequest) {
      if (req.images?.some((image) => image.mediaType === "application/pdf"))
        throw new Error(
          "openai-compatible does not support PDF attachments",
        );
      const base = resolveMessages(req);
      const messages: unknown[] = req.system
        ? [{ role: "system", content: req.system }]
        : [];
      for (let i = 0; i < base.length; i++) {
        const message = base[i]!;
        if (i === base.length - 1 && req.images?.length)
          messages.push({
            role: message.role,
            content: [
              { type: "text", text: message.content },
              ...req.images.map((image) => ({
                type: "image_url",
                image_url: {
                  url: `data:${image.mediaType};base64,${image.data}`,
                },
              })),
            ],
          });
        else messages.push(message);
      }
      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        max_tokens: req.maxTokens,
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        ...(req.schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "response", schema: zodShape(req.schema) },
              },
            }
          : {}),
      };
      logger.log("[llm-gateway:openai-compatible] request", {
        operation: req.operation,
        model: options.model,
        prompt: requestPrompt(req),
        body,
      });
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        const raw = await response.text();
        if (!response.ok)
          throw new Error(
            `OpenAI-compatible request failed with status ${response.status}: ${raw}`,
          );
        const parsed = JSON.parse(raw) as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = parsed.choices?.[0]?.message?.content;
        if (typeof text !== "string")
          throw new Error(
            "OpenAI-compatible response has no choices[0].message.content",
          );
        logger.log("[llm-gateway:openai-compatible] response", {
          operation: req.operation,
          model: options.model,
          text,
          usage: parsed.usage,
        });
        return {
          text,
          usage: {
            inputTokens: parsed.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.usage?.completion_tokens ?? 0,
          },
          stopReason: parsed.choices?.[0]?.finish_reason,
        };
      } catch (error) {
        logger.error("[llm-gateway:openai-compatible] request failed", {
          operation: req.operation,
          model: options.model,
          error,
        });
        throw error;
      }
    },
  };
}
