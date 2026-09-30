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
