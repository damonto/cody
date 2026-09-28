import { z } from "zod";
import type { AccountLimit } from "../types.ts";

export const DEFAULT_ANTIGRAVITY_COOLDOWN_MS = 15 * 60_000;
const detailSchema = z.object({
  "@type": z.string().optional(),
  reason: z.string().optional(),
  retryDelay: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const errorSchema = z.object({
  code: z.number().optional(),
  status: z.string().optional(),
  message: z.string().optional(),
  details: z.array(z.unknown()).optional(),
});
const envelopeSchema = z.object({
  error: z.unknown().optional(),
  response: z.object({ error: z.unknown().optional() }).optional(),
});

function duration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(text)) return undefined;
  let result = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!];
    result += Number(match[1]) * (multiplier ?? 0);
  }
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

/** Google uses RESOURCE_EXHAUSTED for both account limits and shared capacity. */
export function antigravityAccountLimit(
  value: unknown,
  headers: Headers,
  now = Date.now(),
): AccountLimit | undefined {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) return undefined;
  const parsed = errorSchema.safeParse(
    envelope.data.error ?? envelope.data.response?.error,
  );
  if (!parsed.success) return undefined;
  const error = parsed.data;
  if (
    error.status !== "RESOURCE_EXHAUSTED" ||
    (error.code !== undefined && error.code !== 429)
  )
    return undefined;
  const details = (error.details ?? []).flatMap((value) => {
    const parsed = detailSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const reasons = details.filter(
    (detail) => detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );
  const quota =
    reasons.some((detail) => detail.reason === "QUOTA_EXHAUSTED") ||
    (reasons.every((detail) => !detail.reason) &&
      /\bquota[_ ]exhausted\b/i.test(error.message ?? ""));
  const rate = reasons.some(
    (detail) => detail.reason === "RATE_LIMIT_EXCEEDED",
  );
  if (!quota && !rate) return undefined;
  const deadlines: number[] = [];
  for (const detail of reasons) {
    const timestamp = detail.metadata?.quotaResetTimeStamp;
    if (typeof timestamp === "string") deadlines.push(Date.parse(timestamp));
  }
  for (const detail of reasons) {
    const delay = duration(detail.metadata?.quotaResetDelay);
    if (delay !== undefined) deadlines.push(now + delay);
  }
  for (const detail of details) {
    if (detail["@type"] !== "type.googleapis.com/google.rpc.RetryInfo")
      continue;
    const delay = duration(detail.retryDelay);
    if (delay !== undefined) deadlines.push(now + delay);
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    deadlines.push(
      Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter),
    );
  }
  const until = deadlines.find(
    (value) => Number.isFinite(value) && value > now && value <= 8.64e15,
  );
  // An unqualified rate limit is not evidence of a timed account block.
  if (!quota && until === undefined) return undefined;
  return {
    code: quota ? "QUOTA_EXHAUSTED" : "RATE_LIMIT_EXCEEDED",
    resets_at: Math.ceil(until ?? now + DEFAULT_ANTIGRAVITY_COOLDOWN_MS),
  };
}
