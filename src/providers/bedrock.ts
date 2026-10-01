import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { consoleLogger, logSafe, type Logger } from "../logger.js";
import { requestPrompt } from "../request.js";
import type { LlmClient, LlmRequest } from "../types.js";
import {
  buildBedrockMessages,
  buildStructuredToolParams,
  extractAnthropicMessageText,
} from "./message-shape.js";
export type BedrockClientLike = {
  send(cmd: InvokeModelCommand): Promise<{ body?: Uint8Array }>;
};
export function createBedrockClient(options: {
  modelArn: string;
  client?: BedrockClientLike;
  logger?: Logger;
}): LlmClient {
  const logger = options.logger ?? consoleLogger;
  const client = options.client ?? new BedrockRuntimeClient({});
  return {
    provider: "bedrock",
    async complete(req: LlmRequest) {
      // Schema requests use the same structured tool as the anthropic driver.
      // Its system text (incl. the autoTool nudge) is folded into the user
      // message like any system prompt; no top-level `system` is ever sent.
      const { system, tools, tool_choice } = buildStructuredToolParams(req);
      const body: Record<string, unknown> = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: req.maxTokens,
        messages: buildBedrockMessages({ ...req, system }),
        ...(tools ? { tools, tool_choice } : {}),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
      };
      logger.log("[llm-gateway:bedrock] request", {
        operation: req.operation,
        modelArn: options.modelArn,
        prompt: requestPrompt(req),
        body: logSafe(body),
      });
      try {
        const response = await client.send(
          new InvokeModelCommand({
            modelId: options.modelArn,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(body),
          }),
        );
        const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
          content?: Array<{ type: string; text?: string; input?: unknown }>;
          usage?: { input_tokens?: number; output_tokens?: number };
          stop_reason?: string;
        };
        if (!Array.isArray(parsed.content))
          throw new Error("Bedrock response has no content array");
        const text = extractAnthropicMessageText(parsed.content, req);
        logger.log("[llm-gateway:bedrock] response", {
          operation: req.operation,
          modelArn: options.modelArn,
          text,
          usage: parsed.usage,
          stopReason: parsed.stop_reason,
        });
        return {
          text,
          usage: {
            inputTokens: parsed.usage?.input_tokens ?? 0,
            outputTokens: parsed.usage?.output_tokens ?? 0,
          },
          stopReason: parsed.stop_reason,
        };
      } catch (error) {
        logger.error("[llm-gateway:bedrock] request failed", {
          operation: req.operation,
          modelArn: options.modelArn,
          error,
        });
        throw error;
      }
    },
  };
}
