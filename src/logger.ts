export interface Logger {
  log(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
export const consoleLogger: Logger = {
  log: (m, meta) => console.log(m, meta ?? {}),
  warn: (m, meta) => console.warn(m, meta ?? {}),
  error: (m, meta) => console.error(m, meta ?? {}),
};

/**
 * Request bodies for logging: the full prompt is kept, but any string over
 * 10k chars (base64 image/PDF data) is cut to its first 200 chars plus its
 * length, so one attachment does not put megabytes into every log line.
 */
export function logSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === "string" && v.length > 10_000
        ? `${v.slice(0, 200)}…[${v.length} chars truncated]`
        : v,
    ),
  );
}
