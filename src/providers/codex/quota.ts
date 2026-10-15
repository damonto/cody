import { z } from "zod";
import {
  OAuthError,
  quotaBucketSchema,
  quotaCreditsBalanceSchema,
  type AccountView,
  type QuotaSnapshot,
} from "../oauth/schema.ts";

export const MAX_CODEX_QUOTA_GROUPS = 32;
const timestampSchema = z.number().int().nonnegative();
const bucketIdSchema = z.enum(["primary", "secondary"]);
const nameSchema = z.string().trim().min(1).max(160);

/** Observations contain display data only, never routing or spending signals. */
export const codexQuotaObservationSchema = z.object({
  groups: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_.]{1,128}$/),
        label: nameSchema,
        buckets: z
          .array(
            quotaBucketSchema.extend({
              id: bucketIdSchema,
              label: nameSchema,
            }),
          )
          .max(2),
      }),
    )
    .max(MAX_CODEX_QUOTA_GROUPS),
  plan_type: nameSchema.optional(),
  credits_balance: quotaCreditsBalanceSchema
    .extend({
      balance: z.string().max(128).nullable(),
    })
    .optional(),
});
export type CodexQuotaObservation = z.output<
  typeof codexQuotaObservationSchema
>;

/** Only passive windows newer than the last full read need individual clocks. */
export const codexQuotaSyncSchema = z.object({
  full_observed_at: timestampSchema.default(0),
  windows: z
    .array(
      z.object({
        group_id: z.string(),
        bucket_id: bucketIdSchema,
        observed_at: timestampSchema,
      }),
    )
    .max(MAX_CODEX_QUOTA_GROUPS * 2)
    .default([]),
  plan_observed_at: timestampSchema.default(0),
  credits_observed_at: timestampSchema.default(0),
});
export type CodexQuotaSync = z.output<typeof codexQuotaSyncSchema>;
interface CodexQuotaState {
  quota: QuotaSnapshot;
  codex: AccountView["codex"];
  codex_quota_sync: CodexQuotaSync;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function finite(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
export function codexLimitId(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  return normalized === "codex_code_review" ? "code_review" : normalized;
}

function windowName(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds === 18_000) return "5h";
  if (seconds === 604_800) return "weekly";
  const days = seconds / 86_400;
  if (days >= 28 && days <= 31) return "monthly";
  if (seconds % 86_400 === 0) return `${days}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}
const WINDOW_LABELS: Record<string, string> = {
  "5h": "5-hour limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
};
/** Both full usage reads and passive observations share one window representation. */
export function parseCodexWindow(
  id: "primary" | "secondary",
  value: unknown,
  now = Date.now(),
): CodexQuotaObservation["groups"][number]["buckets"][number] | null {
  const window = object(value);
  const used = finite(window.used_percent);
  if (used === null) return null;
  const seconds = finite(window.limit_window_seconds);
  const name = windowName(seconds);
  const resetAt = finite(window.reset_at);
  const resetAfter = finite(window.reset_after_seconds);
  const reset =
    resetAt !== null
      ? resetAt * 1000
      : resetAfter !== null
        ? now + resetAfter * 1000
        : null;
  return {
    id,
    label:
      (name && WINDOW_LABELS[name]) ?? (name ? `${name} limit` : "Usage limit"),
    window: name,
    window_seconds: seconds,
    used_percent: used,
    remaining_fraction: Math.min(1, Math.max(0, 1 - used / 100)),
    reset_at:
      reset !== null && Math.abs(reset) <= 8_640_000_000_000_000
        ? new Date(reset).toISOString()
        : null,
  };
}
function parseCodexLimit(
  id: string,
  label: string,
  value: unknown,
  now: number,
  model: string | null = null,
): QuotaSnapshot["groups"][number] | null {
  const limit = object(value);
  if (!Object.keys(limit).length) return null;
  const buckets = [
    parseCodexWindow("primary", limit.primary_window, now),
    parseCodexWindow("secondary", limit.secondary_window, now),
  ].filter((bucket) => bucket !== null);
  return {
    id: codexLimitId(id),
    label,
    buckets,
    limit_reached: limit.limit_reached === true || limit.allowed === false,
    model,
  };
}

export interface CodexUsage {
  readonly groups: QuotaSnapshot["groups"];
  readonly plan_type: string | null;
  readonly limit_reached: boolean;
  readonly credits_balance: QuotaSnapshot["credits_balance"];
  readonly available_resets: number | null;
}
/** Map `GET /wham/usage` to the shared account quota snapshot. */
export function parseUsage(value: unknown, now = Date.now()): CodexUsage {
  const data = object(value);
  if (!("rate_limit" in data) && !("plan_type" in data))
    throw new OAuthError("Usage response has no rate-limit status", 502);
  const groups = [
    parseCodexLimit("codex", "Codex", data.rate_limit, now),
    parseCodexLimit(
      "code_review",
      "Code review",
      data.code_review_rate_limit,
      now,
    ),
    ...(Array.isArray(data.additional_rate_limits)
      ? data.additional_rate_limits.slice(0, MAX_CODEX_QUOTA_GROUPS)
      : []
    ).map((value, index) => {
      const extra = object(value);
      const name =
        str(extra.limit_name) ?? str(extra.metered_feature) ?? `limit-${index}`;
      return parseCodexLimit(
        str(extra.metered_feature) ?? name,
        name,
        extra.rate_limit,
        now,
        str(extra.normal_model_slug),
      );
    }),
  ].filter((group) => group !== null);
  const credits = object(data.credits);
  const main = object(data.rate_limit);
  return {
    groups: groups
      .filter(
        (group, index) =>
          groups.findIndex((entry) => entry.id === group.id) === index,
      )
      .slice(0, MAX_CODEX_QUOTA_GROUPS),
    plan_type: str(data.plan_type),
    limit_reached: main.limit_reached === true || main.allowed === false,
    credits_balance: Object.keys(credits).length
      ? {
          has_credits: credits.has_credits === true,
          unlimited: credits.unlimited === true,
          // The backend reports the balance as a decimal string or number.
          balance:
            str(credits.balance) ??
            (typeof credits.balance === "number"
              ? String(credits.balance)
              : null),
        }
      : null,
    available_resets: finite(
      object(data.rate_limit_reset_credits).available_count,
    ),
  };
}

function copyState(state: CodexQuotaState): CodexQuotaState {
  return {
    quota: structuredClone(state.quota),
    codex: state.codex && { ...state.codex },
    codex_quota_sync: structuredClone(state.codex_quota_sync),
  };
}
function windowObservation(
  sync: CodexQuotaSync,
  groupId: string,
  bucketId: string,
) {
  return sync.windows.find(
    (entry) => entry.group_id === groupId && entry.bucket_id === bucketId,
  );
}
function updatePlan(state: CodexQuotaState, plan: string) {
  if (state.codex) state.codex.plan_type = plan;
  state.quota.subscription = {
    ...state.quota.subscription,
    tier_id: plan,
    tier_name: state.quota.subscription?.tier_name ?? null,
    credits: state.quota.subscription?.credits ?? [],
    active_until: state.codex?.subscription_active_until ?? null,
  };
}
type QuotaBucket = QuotaSnapshot["groups"][number]["buckets"][number];
function mergeWindow(
  previous: QuotaBucket,
  observed: QuotaBucket,
): QuotaBucket {
  return {
    ...observed,
    label: observed.window == null ? previous.label : observed.label,
    window: observed.window ?? previous.window,
    window_seconds: observed.window_seconds ?? previous.window_seconds,
    reset_at: observed.reset_at ?? previous.reset_at,
  };
}

/** Merge only observed fields. A partial event cannot refresh or clear errors for a full read. */
export function mergeCodexQuotaObservation(
  state: CodexQuotaState,
  observation: CodexQuotaObservation,
  observedAt: number,
): CodexQuotaState {
  const next = copyState(state);
  const sync = next.codex_quota_sync;
  if (observedAt < sync.full_observed_at) return next;
  for (const group of observation.groups) {
    let previous = next.quota.groups.find((entry) => entry.id === group.id);
    if (!previous) {
      if (next.quota.groups.length >= MAX_CODEX_QUOTA_GROUPS) continue;
      previous = { id: group.id, label: group.label, buckets: [] };
      next.quota.groups.push(previous);
    }
    for (const bucket of group.buckets) {
      const clock = windowObservation(sync, group.id, bucket.id);
      if (observedAt < (clock?.observed_at ?? 0)) continue;
      if (clock) clock.observed_at = observedAt;
      else
        sync.windows.push({
          group_id: group.id,
          bucket_id: bucket.id,
          observed_at: observedAt,
        });
      const index = previous.buckets.findIndex(
        (entry) => entry.id === bucket.id,
      );
      if (index < 0) previous.buckets.push(structuredClone(bucket));
      else
        previous.buckets[index] = mergeWindow(previous.buckets[index], bucket);
      // An ID fallback must not replace a known friendly name.
      if (group.label !== group.id) previous.label = group.label;
    }
  }
  if (
    observation.plan_type !== undefined &&
    observedAt >= sync.plan_observed_at
  ) {
    updatePlan(next, observation.plan_type);
    sync.plan_observed_at = observedAt;
  }
  if (
    observation.credits_balance !== undefined &&
    observedAt >= sync.credits_observed_at
  ) {
    next.quota.credits_balance = { ...observation.credits_balance };
    sync.credits_observed_at = observedAt;
  }
  return next;
}

/** Full reads update every independent field while retaining newer passive windows. */
export function mergeCodexQuotaRefresh(
  state: CodexQuotaState,
  usage: CodexUsage,
  startedAt: number,
  completedAt: number,
): CodexQuotaState {
  const next = copyState(state);
  const sync = next.codex_quota_sync;
  if (startedAt < sync.full_observed_at) return next;
  const groups = structuredClone(usage.groups);
  for (const previous of state.quota.groups) {
    const newer = previous.buckets.filter(
      (bucket) =>
        (windowObservation(sync, previous.id, bucket.id)?.observed_at ?? -1) >=
        startedAt,
    );
    if (!newer.length) continue;
    const group = groups.find((entry) => entry.id === previous.id);
    if (group) {
      for (const bucket of newer) {
        const index = group.buckets.findIndex(
          (entry) => entry.id === bucket.id,
        );
        if (index < 0) group.buckets.push(structuredClone(bucket));
        else group.buckets[index] = mergeWindow(group.buckets[index], bucket);
      }
    } else if (groups.length < MAX_CODEX_QUOTA_GROUPS)
      groups.push({ ...previous, buckets: structuredClone(newer) });
  }
  next.quota.groups = groups;
  next.quota.limit_reached = usage.limit_reached;
  next.quota.updated_at = completedAt;
  next.quota.last_error = null;
  next.quota.stale = false;
  sync.full_observed_at = startedAt;
  // Full reads establish a baseline; only newer, still-present windows need clocks.
  sync.windows = sync.windows.filter(
    (entry) =>
      entry.observed_at >= startedAt &&
      groups.some(
        (group) =>
          group.id === entry.group_id &&
          group.buckets.some((bucket) => bucket.id === entry.bucket_id),
      ),
  );
  if (startedAt > sync.plan_observed_at) {
    const plan = usage.plan_type ?? next.codex?.plan_type;
    if (plan) updatePlan(next, plan);
    sync.plan_observed_at = startedAt;
  }
  if (startedAt > sync.credits_observed_at) {
    next.quota.credits_balance = usage.credits_balance && {
      ...usage.credits_balance,
    };
    sync.credits_observed_at = startedAt;
  }
  return next;
}
