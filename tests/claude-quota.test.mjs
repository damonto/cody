import assert from "node:assert/strict";
import test from "node:test";
import { claudeAccount } from "../src/providers/claude/account.ts";
import { ClaudeInventory } from "../src/providers/claude/inventory.ts";
import { parseUsage } from "../src/providers/claude/api.ts";
import { claudeQuotaSyncSchema } from "../src/providers/claude/account-schema.ts";
import {
  headerQuota,
  quotaAvailability,
} from "../src/providers/claude/limits.ts";
import { emptyQuota } from "../src/providers/oauth/state.ts";

function fixture() {
  const now = Date.now();
  const reset = Math.ceil(now / 1000) + 600;
  let account = {
    generation: 1,
    claude_quota_revision: 0,
    claude_quota_sync: claudeQuotaSyncSchema.parse({}),
    claude: { subscription_type: "max", rate_limit_tier: "max_5x" },
    quota: {
      ...emptyQuota(),
      ...parseUsage({
        five_hour: {
          utilization: 10,
          resets_at: new Date(reset * 1000).toISOString(),
        },
        seven_day: {
          utilization: 70,
          resets_at: new Date(reset * 1000).toISOString(),
        },
        seven_day_opus: {
          utilization: 30,
          resets_at: new Date(reset * 1000).toISOString(),
        },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 10,
          utilization: 10,
          disabled_reason: "previous_limit",
        },
      }),
      updated_at: now - 120000,
      last_error: "Previous usage lookup failed",
      stale: true,
    },
  };
  const state = {
    current: () => account,
    async resolve() {
      return {
        token: "test-token",
        claude_organization_id: "org",
        generation: 1,
      };
    },
    async update(generation, change) {
      assert.equal(generation, account.generation);
      const next = structuredClone(account);
      await change(next);
      account = next;
    },
  };
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const inventory = new ClaudeInventory(state, async () => ({
    async usage() {
      started.resolve();
      return response.promise;
    },
  }));
  const fullUsage = {
    five_hour: {
      utilization: 20,
      resets_at: new Date(reset * 1000).toISOString(),
    },
    seven_day: {
      utilization: 40,
      resets_at: new Date(reset * 1000).toISOString(),
    },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 200,
      used_credits: 50,
      utilization: 25,
      disabled_reason: null,
    },
  };
  return {
    now,
    reset,
    state,
    inventory,
    fullUsage,
    started: started.promise,
    finish: () => response.resolve(fullUsage),
    provider: claudeAccount(state, {}),
  };
}

test("Claude full quota reads merge concurrent windows and limits while advancing freshness", async () => {
  for (const [percent, resetOffset] of [
    [80, 0],
    [5, 3600],
  ]) {
    const f = fixture();
    const refresh = f.inventory.quota(1);
    await f.started;
    const observedReset = f.reset + resetOffset;
    await f.provider.observe({
      action: "claude_usage",
      generation: 1,
      groups: headerQuota(
        new Headers({
          "anthropic-ratelimit-unified-5h-utilization": String(percent / 100),
          "anthropic-ratelimit-unified-5h-reset": String(observedReset),
        }),
      ),
    });
    const limit = { model: "opus", until: f.now + 900000 };
    await f.provider.observe({
      action: "claude_limit",
      generation: 1,
      ...limit,
    });
    f.finish();
    await refresh;

    const quota = f.state.current().quota;
    assert.ok(quota.updated_at >= f.now);
    assert.equal(quota.stale, false);
    assert.equal(quota.last_error, null);
    const groups = new Map(quota.groups.map((group) => [group.id, group]));
    assert.equal(groups.get("five_hour").buckets[0].used_percent, percent);
    assert.equal(
      groups.get("five_hour").buckets[0].reset_at,
      new Date(observedReset * 1000).toISOString(),
    );
    assert.equal(groups.get("seven_day").buckets[0].used_percent, 40);
    assert.equal(groups.has("seven_day_opus"), false);
    assert.deepEqual(quota.claude_limits, [limit]);
    assert.deepEqual(quota.extra_usage, f.fullUsage.extra_usage);
  }
});

test("Claude full quota reads preserve a concurrently changed Extra Usage restriction only", async () => {
  for (const reason of ["new_limit", null]) {
    const f = fixture();
    const refresh = f.inventory.quota(1);
    await f.started;
    await f.provider.observe({
      action: "claude_usage",
      generation: 1,
      groups: [],
      extra_usage_disabled_reason: reason,
    });
    f.finish();
    await refresh;
    const quota = f.state.current().quota;
    assert.deepEqual(quota.extra_usage, {
      ...f.fullUsage.extra_usage,
      disabled_reason: reason,
    });
    assert.ok(quota.updated_at >= f.now);
    assert.equal(quota.last_error, null);
    assert.equal(quota.stale, false);
  }
});

test("Claude full quota reads preserve identical repeated window observations", async () => {
  const f = fixture();
  const command = {
    action: "claude_usage",
    generation: 1,
    groups: headerQuota(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(f.reset),
      }),
    ),
  };
  await f.provider.observe(command);
  const before = structuredClone(f.state.current().quota.groups);
  const refresh = f.inventory.quota(1);
  await f.started;
  await f.provider.observe(command);
  assert.deepEqual(f.state.current().quota.groups, before);
  f.fullUsage.five_hour.utilization = 80;
  f.finish();
  await refresh;

  const quota = f.state.current().quota;
  assert.equal(quota.groups[0].buckets[0].used_percent, 100);
  assert.equal(quotaAvailability(quota, "sonnet").subscription, false);
  assert.ok(quota.updated_at >= f.now);
  assert.equal(quota.stale, false);
  assert.equal(quota.last_error, null);

  // A later read with no new observation is authoritative again.
  await f.inventory.quota(1);
  assert.equal(f.state.current().quota.groups[0].buckets[0].used_percent, 80);
  assert.equal(
    quotaAvailability(f.state.current().quota, "sonnet").subscription,
    true,
  );
  assert.deepEqual(f.state.current().claude_quota_sync.windows, []);
});

test("Claude full quota reads preserve identical repeated Extra Usage restrictions", async () => {
  const f = fixture();
  const command = {
    action: "claude_usage",
    generation: 1,
    groups: [],
    extra_usage_disabled_reason: "usage_limit_reached",
  };
  await f.provider.observe(command);
  const before = structuredClone(f.state.current().quota.extra_usage);
  const refresh = f.inventory.quota(1);
  await f.started;
  await f.provider.observe(command);
  assert.deepEqual(f.state.current().quota.extra_usage, before);
  f.finish();
  await refresh;

  const quota = f.state.current().quota;
  assert.deepEqual(quota.extra_usage, {
    ...f.fullUsage.extra_usage,
    disabled_reason: "usage_limit_reached",
  });
  assert.equal(quotaAvailability(quota, "sonnet").extra, false);
  assert.ok(quota.updated_at >= f.now);
  assert.equal(quota.stale, false);
  assert.equal(quota.last_error, null);

  await f.inventory.quota(1);
  assert.deepEqual(
    f.state.current().quota.extra_usage,
    f.fullUsage.extra_usage,
  );
  assert.equal(
    quotaAvailability(f.state.current().quota, "sonnet").extra,
    true,
  );
  assert.equal(f.state.current().claude_quota_sync.extra_usage, null);
});

test("Claude records concurrent Extra Usage restrictions while its balance is unknown", async () => {
  const f = fixture();
  await f.state.update(1, (account) => {
    account.quota.extra_usage = null;
  });
  const refresh = f.inventory.quota(1);
  await f.started;
  await f.provider.observe({
    action: "claude_usage",
    generation: 1,
    groups: [],
    extra_usage_disabled_reason: "usage_limit_reached",
  });
  assert.equal(f.state.current().quota.extra_usage, null);
  f.finish();
  await refresh;

  const quota = f.state.current().quota;
  assert.deepEqual(quota.extra_usage, {
    ...f.fullUsage.extra_usage,
    disabled_reason: "usage_limit_reached",
  });
  assert.equal(quotaAvailability(quota, "sonnet").extra, false);
  assert.ok(quota.updated_at >= f.now);
  assert.equal(quota.stale, false);
  assert.equal(quota.last_error, null);
});

test("Claude ignored older headers do not keep obsolete quota restrictions", async () => {
  const f = fixture();
  const groups = headerQuota(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": String(f.reset),
    }),
  );
  await f.provider.observe({
    action: "claude_usage",
    generation: 1,
    groups,
    extra_usage_disabled_reason: "usage_limit_reached",
  });
  const refresh = f.inventory.quota(1);
  await f.started;
  await f.provider.observe({
    action: "claude_usage",
    generation: 1,
    groups: headerQuota(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.8",
        "anthropic-ratelimit-unified-5h-reset": String(f.reset),
      }),
    ),
  });
  assert.equal(f.state.current().quota.groups[0].buckets[0].used_percent, 100);
  f.finish();
  await refresh;

  const quota = f.state.current().quota;
  assert.equal(quota.groups[0].buckets[0].used_percent, 20);
  assert.deepEqual(quota.extra_usage, f.fullUsage.extra_usage);
  assert.equal(quotaAvailability(quota, "sonnet").subscription, true);
  assert.equal(quotaAvailability(quota, "sonnet").extra, true);
  assert.deepEqual(f.state.current().claude_quota_sync, {
    windows: [],
    extra_usage: null,
  });
});
