import {
  CACHE_WRITE_DURATION_GROUPS,
  type CacheWriteDuration,
} from "../shared/cache-durations.ts";
import type { TokenUsage } from "./types.ts";

type CacheUsage = Pick<
  TokenUsage,
  "cache_write_tokens" | CacheWriteDuration["tokens"]
>;

export function observedCacheDurations(usage: CacheUsage) {
  return Object.values(CACHE_WRITE_DURATION_GROUPS).filter((group) =>
    group.durations.some(({ tokens }) => usage[tokens] != null),
  );
}

export function validCacheWriteUsage(usage: CacheUsage): boolean {
  const groups = observedCacheDurations(usage);
  if (groups.length > 1) return false;
  const total = usage.cache_write_tokens;
  for (const group of groups) {
    let sum = 0;
    let complete = true;
    for (const { tokens } of group.durations) {
      const value = usage[tokens];
      if (value == null) {
        complete = false;
        continue;
      }
      if (!Number.isSafeInteger(value) || value < 0) return false;
      sum += value;
    }
    if (!Number.isSafeInteger(sum)) return false;
    if (total !== null && (sum > total || (complete && sum !== total)))
      return false;
  }
  return true;
}
