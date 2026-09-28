import type { AccountLimit } from "../types.ts";
import type { QuotaSnapshot } from "../oauth/schema.ts";
import { object, text } from "./json.ts";

export interface XaiLimit extends AccountLimit {
  model: string | null;
  kind: "subscription" | "spending";
}
export function quotaAvailability(
  quota: QuotaSnapshot,
  model: string,
  now = Date.now(),
) {
  const groups = quota.groups.filter(
    (group) => !group.model || group.model === model,
  );
  const known =
    !quota.stale &&
    quota.updated_at !== null &&
    now - quota.updated_at < 60000 &&
    groups.some((group) => !group.model) &&
    groups.every(
      (group) =>
        group.buckets.length &&
        group.buckets.every(
          (bucket) => typeof bucket.used_percent === "number",
        ),
    );
  const limits = (quota.xai_limits ?? []).filter(
    (limit) => limit.until > now && (!limit.model || limit.model === model),
  );
  const blocks = groups.flatMap((group) =>
    group.buckets.filter((bucket) => (bucket.used_percent ?? 0) >= 100),
  );
  const blocked = blocks.length > 0 || limits.length > 0;
  const extra = quota.extra_usage;
  const untils = [
    ...blocks.map((bucket) => Date.parse(bucket.reset_at ?? "")),
    ...limits.map((limit) => limit.until),
  ].filter((until) => Number.isFinite(until) && until > now);
  return {
    subscription:
      known && !blocked && !limits.some((limit) => limit.kind === "spending"),
    blocked,
    extra:
      known &&
      extra?.is_enabled === true &&
      extra.monthly_limit !== null &&
      extra.used_credits !== null &&
      extra.used_credits < extra.monthly_limit &&
      !limits.some((limit) => limit.kind === "spending"),
    until: untils.length ? Math.max(...untils) : undefined,
  };
}
export function xaiLimit(
  value: unknown,
  headers: Headers,
  model: string,
  now = Date.now(),
): XaiLimit | undefined {
  const root = object(value);
  const error = object(root.error ?? object(root.response).error);
  const code = text(root.code) || text(error.code);
  const message = text(root.error) || text(error.message) || text(root.message);
  const free = code.includes("free-usage-exhausted");
  const subscription = free || code.includes("subscription:usage-exhausted");
  const spending =
    code.includes("spending-limit") ||
    code === "insufficient_quota" ||
    code === "credits_exhausted";
  if (!subscription && !spending) return undefined;
  const raw =
    root.resets_at ?? error.resets_at ?? root.reset_at ?? error.reset_at;
  let until =
    typeof raw === "number"
      ? raw < 1e12
        ? raw * 1000
        : raw
      : Date.parse(text(raw));
  if (!Number.isFinite(until) || until <= now) {
    const retry = headers.get("retry-after");
    until =
      retry && /^\d+(\.\d+)?$/.test(retry)
        ? now + Number(retry) * 1000
        : Date.parse(retry ?? "");
  }
  const reset_source =
    Number.isFinite(until) && until > now ? "upstream" : "fallback";
  if (reset_source === "fallback") until = now + (free ? 24 * 60 : 15) * 60000;
  return {
    code,
    resets_at: until,
    model: free && message.includes(model) ? model : null,
    kind: spending ? "spending" : "subscription",
    reset_source,
  };
}
