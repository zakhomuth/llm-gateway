import type { LlmMessage, LlmRequest } from "./types.js";
export * from "./types.js";

export function validateRequest(req: LlmRequest): void {
  const promptSet = req.prompt !== undefined;
  const messagesSet = req.messages !== undefined;
  if (promptSet === messagesSet)
    throw new Error("Exactly one of prompt or messages must be set");
}

export function resolveMessages(req: LlmRequest): LlmMessage[] {
  validateRequest(req);
  return req.messages ?? [{ role: "user", content: req.prompt! }];
}

export function requestPrompt(req: LlmRequest): string {
  validateRequest(req);
  return req.prompt ?? JSON.stringify(req.messages);
}
