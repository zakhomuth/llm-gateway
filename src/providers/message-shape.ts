import type { ZodTypeAny } from "zod";
import { zodShape } from "../key.js";
import { resolveMessages } from "../request.js";
import type { LlmRequest } from "../types.js";

export const STRUCTURED_TOOL_NAME = "emit_structured_result";
export const AUTO_TOOL_NUDGE = "Return only the tool call and no additional text.";

export function extractAnthropicMessageText(
  content: Array<{ type: string; text?: string; input?: unknown }>,
  req?: LlmRequest,
): string {
  const toolBlock = content.find((c) => c.type === "tool_use");
  const textBlocks = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "");
  // A schema request's answer is the tool input, even if the model also wrote
  // a text preamble (possible with autoTool).
  if (textBlocks.length && !(req?.schema && toolBlock))
    return textBlocks.join("");
  if (!toolBlock) return "";
  if (req?.schema && isWrappedSchema(req.schema))
    return JSON.stringify((toolBlock.input as { result: unknown }).result);
  return JSON.stringify(toolBlock.input);
}

export function isWrappedSchema(schema: ZodTypeAny): boolean {
  const shape = zodShape(schema) as { type?: string };
  return shape.type !== "object";
}

/**
 * Structured (schema) requests ride Anthropic's tool-use mechanism: a forced
 * tool_choice by default, or `{type:"auto"}` (with a nudge appended to
 * system) when `req.autoTool` is set. Non-schema requests just pass system
 * through unchanged.
 */
export function buildStructuredToolParams(
  req: LlmRequest,
): { system?: string; tools?: unknown[]; tool_choice?: unknown } {
  if (!req.schema) return req.system ? { system: req.system } : {};
  const shape = zodShape(req.schema);
  const tool = {
    name: STRUCTURED_TOOL_NAME,
    description: "Emit the structured result.",
    input_schema: isWrappedSchema(req.schema)
      ? { type: "object", properties: { result: shape }, required: ["result"] }
      : shape,
  };
  if (req.autoTool) {
    return {
      tools: [tool],
      tool_choice: { type: "auto" },
      system: req.system
        ? `${req.system}\n\n${AUTO_TOOL_NUDGE}`
        : AUTO_TOOL_NUDGE,
    };
  }
  return {
    tools: [tool],
    tool_choice: { type: "tool", name: STRUCTURED_TOOL_NAME },
    ...(req.system ? { system: req.system } : {}),
  };
}

export type AnthropicContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
      };
    };
export function buildAnthropicStyleMessages(
  req: LlmRequest,
): Array<{ role: "user" | "assistant"; content: AnthropicContent[] }> {
  const messages = resolveMessages(req).map((m) => ({
    role: m.role,
    content: [{ type: "text" as const, text: m.content }] as AnthropicContent[],
  }));
  if (req.images?.length) {
    const target = req.messages
      ? messages.find((message) => message.role === "user")
      : messages[0];
    target?.content.unshift(
      ...req.images.map(
        (image): AnthropicContent =>
          image.mediaType === "application/pdf"
            ? {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: image.data,
                },
              }
            : {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mediaType,
                  data: image.data,
                },
              },
      ),
    );
  }
  return messages;
}
export function buildBedrockMessages(
  req: LlmRequest,
): ReturnType<typeof buildAnthropicStyleMessages> {
  const messages = buildAnthropicStyleMessages(req);
  if (req.system)
    messages[0]!.content.unshift({ type: "text", text: req.system });
  return messages;
}
