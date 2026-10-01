import Anthropic from "@anthropic-ai/sdk";
import { consoleLogger, logSafe, type Logger } from "../logger.js";
import { requestPrompt } from "../request.js";
import type { LlmClient, LlmRequest } from "../types.js";
import {
  buildAnthropicStyleMessages,
  buildStructuredToolParams,
  extractAnthropicMessageText,
} from "./message-shape.js";
export interface AnthropicClientLike {
  messages: {
    create(
      params: any,
    ): Promise<{
      content: Array<{
        type: string;
        text?: string;
        input?: unknown;
        name?: string;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string | null;
    }>;
  };
}
// Current Claude API ID (pinned snapshot) for Claude Sonnet 5.5.
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
export function createAnthropicClient(
  options: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    anthropicClient?: AnthropicClientLike;
    logger?: Logger;
  } = {},
): LlmClient {
  const logger = options.logger ?? consoleLogger;
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  let client = options.anthropicClient;
  const getClient = (): AnthropicClientLike =>
    (client ??= new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    }) as unknown as AnthropicClientLike);
  return {
    provider: "anthropic",
    async complete(req: LlmRequest) {
      const body: Record<string, unknown> = {
        model,
        max_tokens: req.maxTokens,
        messages: buildAnthropicStyleMessages(req),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        ...buildStructuredToolParams(req),
      };
      logger.log("[llm-gateway:anthropic] request", {
        operation: req.operation,
        model,
        prompt: requestPrompt(req),
        body: logSafe(body),
      });
      try {
        const response = await getClient().messages.create(body);
        const text = extractAnthropicMessageText(response.content, req);
        logger.log("[llm-gateway:anthropic] response", {
          operation: req.operation,
          model,
          text,
          usage: response.usage,
          stopReason: response.stop_reason,
        });
        return {
          text,
          usage: {
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
          },
          ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
        };
      } catch (error) {
        logger.error("[llm-gateway:anthropic] request failed", {
          operation: req.operation,
          model,
          prompt: requestPrompt(req),
          error,
        });
        throw error;
      }
    },
  };
}
