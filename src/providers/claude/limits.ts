import type { QuotaSnapshot } from "../oauth/schema.ts";

export function modelFamily(model: string): string {
  return /(?:^|[-_.])opus(?:[-_.]|$)/i.test(model)
    ? "opus"
    : /(?:^|[-_.])sonnet(?:[-_.]|$)/i.test(model)
      ? "sonnet"
      : model;
}
export function quotaBlocks(
  quota: QuotaSnapshot,
  now = Date.now(),
): { model: string | null; until: number | null }[] {
  return [
    ...quota.groups.flatMap((group) =>
      group.buckets.flatMap((bucket) => {
        if (
          (bucket.used_percent ?? (bucket.remaining_fraction === 0 ? 100 : 0)) <
          100
        )
          return [];
        const parsed = bucket.reset_at ? Date.parse(bucket.reset_at) : NaN;
        if (Number.isFinite(parsed) && parsed <= now) return [];
        return [
          {
            model: group.model ?? null,
            until: Number.isFinite(parsed) ? parsed : null,
          },
        ];
      }),
    ),
    ...(quota.claude_limits ?? []).filter((limit) => limit.until > now),
  ];
}
export function quotaAvailability(
  quota: QuotaSnapshot,
  model: string,
  now = Date.now(),
) {
  const blocks = quotaBlocks(quota, now).filter(
    (block) =>
      !block.model ||
      block.model === modelFamily(model) ||
      block.model === model,
  );
  const applicableGroups = quota.groups.filter(
    (group) =>
      !group.model ||
      group.model === modelFamily(model) ||
      group.model === model,
  );
  const known =
    !quota.stale &&
    quota.updated_at !== null &&
    now - quota.updated_at < 60000 &&
    applicableGroups.some((group) => !group.model) &&
    applicableGroups.every(
      (group) =>
        group.buckets.length > 0 &&
        group.buckets.every(
          (bucket) =>
            bucket.used_percent !== null && bucket.used_percent !== undefined,
        ),
    );
  const extra = quota.extra_usage;
  return {
    subscription: known && blocks.length === 0,
    extra:
      known &&
      extra?.is_enabled === true &&
      extra.disabled_reason == null &&
      (extra.monthly_limit === null ||
        (extra.used_credits !== null &&
          extra.used_credits < extra.monthly_limit)) &&
      (extra.utilization === null || extra.utilization < 100),
    blocked: blocks.length > 0,
    until:
      blocks.length && blocks.every((block) => block.until !== null)
        ? Math.max(...blocks.map((block) => block.until!))
        : undefined,
  };
}
/** Only explicit subscription-limit signals allow replay; generic rate limits do not. */
export interface ClaudeLimit {
  model: string | null;
  until: number;
}
export function claudeUsageLimit(
  response: Response,
  model: string,
  now = Date.now(),
): (ClaudeLimit & { additional_limits?: ClaudeLimit[] }) | undefined {
  if (response.status !== 429) return undefined;
  const headers = response.headers;
  const blocks = new Map<string | null, number>();
  const deadline = (value: string | null): number | undefined => {
    const seconds = value ? Number(value) : NaN;
    return Number.isFinite(seconds) &&
      seconds <= 8640000000000 &&
      seconds * 1000 > now
      ? seconds * 1000
      : undefined;
  };
  const add = (scope: string | null, reset: string | null) => {
    const until = deadline(reset) ?? now + 15 * 60000;
    blocks.set(scope, Math.max(blocks.get(scope) ?? 0, until));
  };
  for (const window of ["5h", "7d"] as const) {
    if (
      headers.get(`anthropic-ratelimit-unified-${window}-status`) === "rejected"
    )
      add(null, headers.get(`anthropic-ratelimit-unified-${window}-reset`));
  }
  if (headers.get("anthropic-ratelimit-unified-7d_oi-status") === "rejected")
    add(
      modelFamily(model),
      headers.get("anthropic-ratelimit-unified-7d_oi-reset"),
    );
  const claim = headers.get("anthropic-ratelimit-unified-representative-claim");
  // Extra usage/fast-mode rejection alone does not exhaust subscription quota.
  if (
    headers.get("anthropic-ratelimit-unified-status") === "rejected" &&
    claim !== "overage"
  ) {
    const scope =
      claim === "seven_day_opus"
        ? "opus"
        : claim === "seven_day_sonnet"
          ? "sonnet"
          : ["five_hour", "seven_day", "seven_day_oauth_apps"].includes(
                claim ?? "",
              )
            ? null
            : modelFamily(model);
    add(scope, headers.get("anthropic-ratelimit-unified-reset"));
  }
  const limits = [...blocks]
    .map(([model, until]) => ({ model, until }))
    .sort((left, right) => right.until - left.until);
  const [first, ...additional] = limits;
  return first
    ? {
        ...first,
        ...(additional.length ? { additional_limits: additional } : {}),
      }
    : undefined;
}

/** Response headers report utilization as a fraction, unlike the usage API's percentage. */
export function headerQuota(headers: Headers): QuotaSnapshot["groups"] {
  return (
    [
      ["5h", "five_hour"],
      ["7d", "seven_day"],
    ] as const
  ).flatMap(([header, id]) => {
    const raw = headers.get(
      `anthropic-ratelimit-unified-${header}-utilization`,
    );
    const reset = headers.get(`anthropic-ratelimit-unified-${header}-reset`);
    if (raw === null || reset === null) return [];
    const used = Number(raw);
    const seconds = Number(reset);
    if (
      !Number.isFinite(used) ||
      used < 0 ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 8640000000000
    )
      return [];
    return [
      {
        id,
        label: id.replaceAll("_", " "),
        model: null,
        buckets: [
          {
            id,
            label: id.replaceAll("_", " "),
            window: header === "5h" ? "5h" : "weekly",
            remaining_fraction: Math.max(0, 1 - used),
            used_percent: used * 100,
            reset_at: new Date(seconds * 1000).toISOString(),
          },
        ],
      },
    ];
  });
}

/** Translate observation headers without modifying the response itself. */
export function responseQuotaObservation(headers: Headers) {
  const groups = headerQuota(headers);
  const status = headers.get("anthropic-ratelimit-unified-overage-status");
  const reason = headers.get(
    "anthropic-ratelimit-unified-overage-disabled-reason",
  );
  if (!groups.length && status === null && reason === null) return undefined;
  return {
    groups,
    ...(status !== null || reason !== null
      ? {
          extra_usage_disabled_reason:
            reason ?? (status === "rejected" ? "usage_limit_reached" : null),
        }
      : {}),
  };
}
