import { LlmBudgetExceededError } from "./errors.js";
import { consoleLogger, type Logger } from "./logger.js";
import { utcDateString, type SpendLedger } from "./cost.js";
export async function checkDailyBudget(
  ledger: SpendLedger,
  capUsd: number,
  tenantId?: string,
  logger: Logger = consoleLogger,
  now = new Date(),
): Promise<void> {
  const spend = await ledger.dailySpendUsd(utcDateString(now), tenantId);
  if (spend >= capUsd) {
    logger.warn("[llm-gateway] daily budget exceeded", {
      spend,
      capUsd,
      tenantId,
    });
    throw new LlmBudgetExceededError(capUsd, tenantId);
  }
}
