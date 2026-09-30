import { ShutdownRequestedError } from "./errors.js";
import { consoleLogger, type Logger } from "./logger.js";
let pending: NodeJS.Signals | undefined;
export function shutdownPending(): boolean {
  return pending !== undefined;
}
export function __resetShutdownStateForTests(): void {
  pending = undefined;
}
export async function deferredShutdown<T>(
  fn: () => Promise<T>,
  options: { resend?: (pid: number, signal: NodeJS.Signals) => void } = {},
): Promise<T> {
  if (pending) throw new ShutdownRequestedError();
  const handler = (signal: NodeJS.Signals) => {
    pending = signal;
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  try {
    return await fn();
  } finally {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
    if (pending)
      (options.resend ?? process.kill.bind(process))(process.pid, pending);
  }
}
export class Drain {
  private _stopping = false;
  constructor(private readonly logger: Logger = consoleLogger) {}
  install(): this {
    const stop = (signal: NodeJS.Signals) => {
      this._stopping = true;
      this.logger.warn("[llm-gateway] drain requested", { signal });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return this;
  }
  get stopping(): boolean {
    return this._stopping;
  }
}
