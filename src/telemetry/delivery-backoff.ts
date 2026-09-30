import { z } from "zod";

export const RETRY_DELAY_MS = 10_000;
export const MAX_RETRY_DELAY_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_FAILURES = 20;

const retrySchema = z.object({
  failures: z.number().int().min(1).max(MAX_FAILURES),
  until: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type DeliveryRetry = z.infer<typeof retrySchema>;

export function parseDeliveryRetry(value: unknown): DeliveryRetry | undefined {
  const result = retrySchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function dailyLimitExceeded(error: unknown): boolean {
  // Binding errors may wrap the service error in `cause`. Keep traversal bounded.
  for (
    let depth = 0;
    depth < 4 && error !== null && typeof error === "object";
    depth++
  ) {
    if (
      "code" in error &&
      (error.code === 10253 ||
        error.code === "10253" ||
        error.code === "FreeTierLimitExceeded")
    )
      return true;
    if (
      "message" in error &&
      typeof error.message === "string" &&
      /\b10253\b|FreeTierLimitExceeded|free tier limit exceeded|exceeded.*daily.*(?:limit|quota)|daily.*(?:limit|quota).*exceeded/i.test(
        error.message,
      )
    )
      return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

export function nextDeliveryRetry(
  previous: DeliveryRetry | undefined,
  error: unknown,
): DeliveryRetry {
  const failures = Math.min(MAX_FAILURES, (previous?.failures ?? 0) + 1);
  const now = Date.now();
  const delay = Math.min(
    MAX_RETRY_DELAY_MS,
    RETRY_DELAY_MS * 2 ** (failures - 1),
  );
  return {
    failures,
    until: dailyLimitExceeded(error)
      ? (Math.floor(now / DAY_MS) + 1) * DAY_MS +
        1000 +
        Math.floor(Math.random() * 60_000)
      : now + Math.floor(delay * (0.75 + Math.random() * 0.25)),
  };
}
