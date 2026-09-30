import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { consoleLogger, type Logger } from "../logger.js";
import { requestPrompt } from "../request.js";
import type { LlmClient, LlmRequest } from "../types.js";
import { buildBedrockMessages } from "./message-shape.js";
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
      const body: Record<string, unknown> = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: req.maxTokens,
        messages: buildBedrockMessages(req),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
      };
      logger.log("[llm-gateway:bedrock] request", {
        operation: req.operation,
        modelArn: options.modelArn,
        prompt: requestPrompt(req),
        body,
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
          content?: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
          stop_reason?: string;
        };
        if (!Array.isArray(parsed.content))
          throw new Error("Bedrock response has no content array");
        const text = parsed.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
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
