import type { ZodType } from "zod";

export type LlmMessageRole = "user" | "assistant";
export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}
export interface LlmImage {
  data: string;
  mediaType: string;
}
export type LlmAttachment = LlmImage;
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface LlmRequest<TSchema = unknown> {
  operation: string;
  prompt?: string;
  messages?: LlmMessage[];
  system?: string;
  images?: LlmImage[];
  schema?: ZodType<TSchema>;
  maxTokens: number;
  temperature?: number;
  sample?: number;
  tenantId?: string;
  fresh?: boolean;
  batchable?: boolean;
  autoTool?: boolean;
  validationRetries?: number;
}
export interface LlmResult<TParsed = unknown> {
  text: string;
  parsed?: TParsed;
  usage: LlmUsage;
  cached: boolean;
  costUsd: number;
  stopReason?: string;
}
export interface LlmProviderResult {
  text: string;
  usage: LlmUsage;
  stopReason?: string;
}
export interface LlmClient {
  readonly provider: string;
  complete(req: LlmRequest): Promise<LlmProviderResult>;
}
