import assert from "node:assert/strict";
import test from "node:test";
import {
  codexQuotaSyncSchema,
  mergeCodexQuotaObservation,
  mergeCodexQuotaRefresh,
  parseUsage,
} from "../src/providers/codex/quota.ts";
import { codexQuotaEvent } from "../src/providers/codex/observations.ts";
import { emptyQuota } from "../src/providers/oauth/state.ts";

const now = 1_800_000_000_000;
const credits = (balance) => ({ has_credits: true, unlimited: false, balance });
function state() {
  return {
    codex: {
      account_id: "account",
      user_id: null,
      plan_type: "plus",
      subscription_active_until: null,
    },
    quota: emptyQuota(),
    codex_quota_sync: codexQuotaSyncSchema.parse({}),
  };
}
function usage(primary, secondary, extra = {}) {
  return parseUsage(
    {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: primary,
          limit_window_seconds: 18000,
          reset_at: 1800018000,
        },
        secondary_window: {
          used_percent: secondary,
          limit_window_seconds: 604800,
        },
      },
      ...extra,
    },
    now,
  );
}
function observe(current, data, at) {
  const observation = codexQuotaEvent({ type: "codex.rate_limits", ...data });
  assert.ok(observation);
  return mergeCodexQuotaObservation(current, observation, at);
}
function percentages(current, id = "codex") {
  return current.quota.groups
    .find((group) => group.id === id)
    ?.buckets.map((bucket) => bucket.used_percent);
}

test("a full read merges untouched windows, groups and exhaustion without losing newer passive data", () => {
  const original = mergeCodexQuotaRefresh(
    state(),
    usage(100, 80),
    now - 1000,
    now - 900,
  );
  original.quota.limit_reached = true;
  original.quota.last_error = "Previous refresh failed";
  original.quota.reset_credits = {
    available_count: 1,
    credits: [],
    updated_at: now - 900,
    error: null,
  };
  const previous = observe(
    original,
    {
      rate_limits: { primary: { used_percent: 5 } },
      plan_type: "pro",
      credits: credits("7.5"),
    },
    now + 100,
  );
  const before = structuredClone(previous);
  const next = mergeCodexQuotaRefresh(
    previous,
    usage(10, 20, {
      credits: credits("2"),
      code_review_rate_limit: { primary_window: { used_percent: 30 } },
    }),
    now,
    now + 200,
  );
  assert.deepEqual(percentages(next), [5, 20]);
  assert.deepEqual(percentages(next, "code_review"), [30]);
  assert.equal(next.quota.limit_reached, false);
  assert.equal(next.quota.last_error, null);
  assert.equal(next.quota.updated_at, now + 200);
  assert.equal(next.codex.plan_type, "pro");
  assert.equal(next.quota.credits_balance.balance, "7.5");
  assert.deepEqual(next.quota.reset_credits, original.quota.reset_credits);
  assert.equal(next.quota.groups[0].buckets[0].label, "5-hour limit");
  assert.equal(
    next.quota.groups[0].buckets[0].reset_at,
    "2027-01-15T13:00:00.000Z",
  );
  assert.deepEqual(previous, before);
});

test("the first full read fills missing metadata while retaining a newer observed percentage", () => {
  const previous = observe(
    state(),
    { rate_limits: { primary: { used_percent: 5 } } },
    now + 100,
  );
  const next = mergeCodexQuotaRefresh(previous, usage(10, 20), now, now + 200);
  assert.deepEqual(next.quota.groups[0].buckets[0], {
    id: "primary",
    label: "5-hour limit",
    window: "5h",
    window_seconds: 18000,
    used_percent: 5,
    remaining_fraction: 0.95,
    reset_at: "2027-01-15T13:00:00.000Z",
  });
  assert.equal(previous.quota.groups[0].buckets[0].window, null);
});

test("out-of-order observations compare each window, plan and balance independently after persistence", () => {
  let current = observe(
    state(),
    {
      rate_limits: { primary: { used_percent: 5 } },
      plan_type: "pro",
    },
    now + 200,
  );
  current = JSON.parse(JSON.stringify(current));
  current.codex_quota_sync = codexQuotaSyncSchema.parse(
    current.codex_quota_sync,
  );
  current = observe(
    current,
    {
      rate_limits: {
        secondary: { used_percent: 20 },
        primary: { used_percent: 99 },
      },
      plan_type: "plus",
      credits: credits("7.5"),
    },
    now + 100,
  );
  assert.deepEqual(percentages(current), [5, 20]);
  assert.equal(current.codex.plan_type, "pro");
  assert.equal(current.quota.credits_balance.balance, "7.5");
  assert.equal(current.quota.updated_at, null);
});

test("partial observations preserve complete-read freshness, errors and reset credits", () => {
  const initial = mergeCodexQuotaRefresh(
    state(),
    usage(10, 20),
    now - 120000,
    now - 120000,
  );
  initial.quota.last_error = "Usage lookup failed";
  initial.quota.reset_credits = {
    available_count: 0,
    credits: [],
    updated_at: null,
    error: "Credits lookup failed",
  };
  const next = observe(
    initial,
    { plan_type: "pro", rate_limits: { primary: { used_percent: 15 } } },
    now,
  );
  assert.equal(next.quota.updated_at, now - 120000);
  assert.equal(next.quota.last_error, "Usage lookup failed");
  assert.deepEqual(next.quota.reset_credits, initial.quota.reset_credits);
});

test("a newer partial-only group survives a full read, then a later full read removes it and its clock", () => {
  const observed = observe(
    state(),
    {
      metered_limit_name: "codex-spark",
      rate_limits: { primary: { used_percent: 15 } },
    },
    now,
  );
  const first = mergeCodexQuotaRefresh(observed, usage(10, 20), now, now + 10);
  assert.deepEqual(percentages(first, "codex_spark"), [15]);
  assert.equal(first.codex_quota_sync.windows.length, 1);
  const second = mergeCodexQuotaRefresh(
    first,
    usage(30, 40),
    now + 20,
    now + 30,
  );
  assert.equal(percentages(second, "codex_spark"), undefined);
  assert.deepEqual(second.codex_quota_sync.windows, []);
  const delayed = observe(
    second,
    { rate_limits: { primary: { used_percent: 99 } }, plan_type: "free" },
    now + 15,
  );
  assert.deepEqual(delayed, second);
});

test("full and passive sources use the same canonical metered-limit identity", () => {
  const initial = mergeCodexQuotaRefresh(
    state(),
    usage(10, 20, {
      additional_rate_limits: [
        {
          metered_feature: "Codex-Spark",
          limit_name: "Spark",
          rate_limit: { primary_window: { used_percent: 30 } },
        },
      ],
    }),
    now,
    now,
  );
  const next = observe(
    initial,
    {
      metered_limit_name: "codex_spark",
      rate_limits: { primary: { used_percent: 40 } },
    },
    now + 1,
  );
  assert.equal(next.quota.groups.length, 2);
  assert.deepEqual(percentages(next, "codex_spark"), [40]);
  assert.equal(next.quota.groups[1].label, "Spark");
});
