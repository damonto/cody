import { z } from "zod";
import {
  MAX_CODEX_QUOTA_GROUPS as MAX_GROUPS,
  codexLimitId,
  codexQuotaObservationSchema,
  parseCodexWindow,
  type CodexQuotaObservation,
} from "./quota.ts";

const nameSchema = z.string().trim().min(1).max(160);

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function name(value: unknown): string | undefined {
  const result = nameSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
function number(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= maximum
    ? result
    : undefined;
}
function id(value: unknown): string | undefined {
  const parsed = name(value);
  const normalized = parsed && codexLimitId(parsed);
  return normalized && /^[a-z0-9_.]{1,128}$/.test(normalized)
    ? normalized
    : undefined;
}
function bool(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return;
}
function credits(value: unknown): CodexQuotaObservation["credits_balance"] {
  const data = object(value);
  const has = bool(data.has_credits ?? data.hasCredits);
  const unlimited = bool(data.unlimited);
  if (has === undefined || unlimited === undefined) return;
  const balance =
    typeof data.balance === "number" && Number.isFinite(data.balance)
      ? String(data.balance)
      : data.balance;
  if (balance != null && (typeof balance !== "string" || balance.length > 128))
    return;
  return {
    has_credits: has,
    unlimited,
    balance: balance == null ? null : balance.trim() || null,
  };
}
function window(value: unknown): Record<string, unknown> | undefined {
  const data = object(value);
  const used = number(data.used_percent ?? data.usedPercent, 1_000_000);
  if (used === undefined) return;
  const minutes = number(data.window_minutes ?? data.windowMinutes, 525_600);
  const seconds =
    number(data.limit_window_seconds, 31_536_000) ??
    (minutes === undefined ? undefined : minutes * 60);
  return {
    used_percent: used,
    limit_window_seconds: seconds,
    reset_at: number(data.reset_at ?? data.resetAt, 8_640_000_000_000),
    reset_after_seconds: number(data.reset_after_seconds, 31_536_000),
  };
}
function group(limitId: string, label: string, value: unknown) {
  const data = object(value);
  const buckets = [
    parseCodexWindow("primary", window(data.primary ?? data.primary_window)),
    parseCodexWindow(
      "secondary",
      window(data.secondary ?? data.secondary_window),
    ),
  ].filter((bucket) => bucket !== null);
  if (buckets.length) return { id: limitId, label, buckets };
  return;
}
function observation(
  value: CodexQuotaObservation,
): CodexQuotaObservation | undefined {
  if (
    !value.groups.length &&
    value.plan_type === undefined &&
    value.credits_balance === undefined
  )
    return;
  const parsed = codexQuotaObservationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Official x-{metered-limit}-primary/secondary header families. */
export function codexQuotaHeaders(
  headers: Headers,
): CodexQuotaObservation | undefined {
  const ids = new Set<string>();
  for (const key of headers.keys()) {
    const match = /^x-([a-z0-9_.-]+)-(?:primary|secondary)-used-percent$/.exec(
      key,
    );
    if (match && ids.size < MAX_GROUPS) ids.add(match[1]);
  }
  const groups: CodexQuotaObservation["groups"] = [];
  for (const raw of ids) {
    const limitId = id(raw);
    if (!limitId) continue;
    const prefix = `x-${raw}`;
    const readWindow = (key: string) => ({
      used_percent: headers.get(`${prefix}-${key}-used-percent`),
      window_minutes: headers.get(`${prefix}-${key}-window-minutes`),
      reset_at: headers.get(`${prefix}-${key}-reset-at`),
    });
    const parsed = group(
      limitId,
      name(headers.get(`${prefix}-limit-name`)) ??
        (limitId === "codex" ? "Codex" : limitId),
      {
        primary: readWindow("primary"),
        secondary: readWindow("secondary"),
      },
    );
    if (parsed) groups.push(parsed);
  }
  const balance = credits({
    has_credits: headers.get("x-codex-credits-has-credits")?.toLowerCase(),
    unlimited: headers.get("x-codex-credits-unlimited")?.toLowerCase(),
    balance: headers.get("x-codex-credits-balance"),
  });
  const plan = name(headers.get("x-codex-plan-type"));
  return observation({
    groups,
    ...(plan ? { plan_type: plan } : {}),
    ...(balance ? { credits_balance: balance } : {}),
  });
}

/** codex.rate_limits is observed without consuming or rewriting the client frame. */
export function codexQuotaEvent(
  value: unknown,
): CodexQuotaObservation | undefined {
  const data = object(value);
  if (data.type !== "codex.rate_limits") return;
  const limitId = id(
    data.metered_limit_name ??
      data.meteredLimitName ??
      data.limit_name ??
      data.limitName ??
      "codex",
  );
  const groups: CodexQuotaObservation["groups"] = [];
  if (limitId) {
    const parsed = group(
      limitId,
      name(data.limit_name ?? data.limitName) ??
        (limitId === "codex" ? "Codex" : limitId),
      data.rate_limits ?? data.rateLimit ?? data.rateLimits,
    );
    if (parsed) groups.push(parsed);
  }
  const review = group(
    "code_review",
    "Code review",
    data.code_review_rate_limits ?? data.codeReviewRateLimits,
  );
  if (review) groups.push(review);
  const extra = data.additional_rate_limits ?? data.additionalRateLimits;
  const entries = Array.isArray(extra)
    ? extra
        .slice(0, MAX_GROUPS - groups.length)
        .map((value) => [undefined, value] as const)
    : Object.entries(object(extra)).slice(0, MAX_GROUPS - groups.length);
  for (const [key, value] of entries) {
    const detail = object(value);
    const limitId = id(
      detail.metered_feature ??
        detail.metered_limit_name ??
        detail.limit_name ??
        detail.limitName ??
        key,
    );
    if (!limitId) continue;
    const parsed = group(
      limitId,
      name(detail.limit_name ?? detail.limitName) ?? limitId,
      detail.rate_limits ?? detail.rate_limit ?? detail.rateLimit ?? detail,
    );
    if (parsed && !groups.some((group) => group.id === limitId))
      groups.push(parsed);
  }
  const plan = name(data.plan_type ?? data.planType);
  const balance = credits(data.credits);
  return observation({
    groups,
    ...(plan ? { plan_type: plan } : {}),
    ...(balance ? { credits_balance: balance } : {}),
  });
}
