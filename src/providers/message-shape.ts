import { zodShape } from "../key.js";
import { resolveMessages } from "../request.js";
import type { LlmRequest } from "../types.js";

export const STRUCTURED_TOOL_NAME = "emit_structured_result";
export const AUTO_TOOL_NUDGE = "Return only the tool call and no additional text.";

export function extractAnthropicMessageText(
  content: Array<{ type: string; text?: string; input?: unknown }>,
): string {
  const textBlocks = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "");
  if (textBlocks.length) return textBlocks.join("");
  const toolBlock = content.find((c) => c.type === "tool_use");
  return toolBlock ? JSON.stringify(toolBlock.input) : "";
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
  const tool = {
    name: STRUCTURED_TOOL_NAME,
    description: "Emit the structured result.",
    input_schema: zodShape(req.schema),
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
    };
export function buildAnthropicStyleMessages(
  req: LlmRequest,
): Array<{ role: "user" | "assistant"; content: AnthropicContent[] }> {
  const messages = resolveMessages(req).map((m) => ({
    role: m.role,
    content: [{ type: "text" as const, text: m.content }] as AnthropicContent[],
  }));
  if (!req.messages && req.images?.length)
    messages[0]!.content.push(
      ...req.images.map((image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mediaType,
          data: image.data,
        },
      })),
    );
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
