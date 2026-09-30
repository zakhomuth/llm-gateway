export class LlmPausedError extends Error {
  readonly code = "LLM_PAUSED";
  constructor(message: string) {
    super(message);
    this.name = "LlmPausedError";
  }
}
export function isLlmPausedError(err: unknown): err is LlmPausedError {
  return (
    err instanceof LlmPausedError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "LLM_PAUSED")
  );
}
export class LlmBudgetExceededError extends LlmPausedError {
  constructor(capUsd: number, tenantId?: string) {
    super(
      `Daily LLM budget cap of $${capUsd} exceeded${tenantId ? ` for tenant ${tenantId}` : ""}`,
    );
    this.name = "LlmBudgetExceededError";
  }
}
export class TransportFailure extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "TransportFailure";
    this.reason = reason;
  }
}
export class ShutdownRequestedError extends Error {
  constructor(message = "Shutdown requested; refusing new LLM call") {
    super(message);
    this.name = "ShutdownRequestedError";
  }
}
