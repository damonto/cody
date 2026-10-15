import assert from "node:assert/strict";
import test from "node:test";
import { claudeQuotaRoute } from "../src/providers/claude/routing.ts";
import { xaiQuotaRoute } from "../src/providers/xai/routing.ts";
import { accountViewSchema } from "../src/providers/oauth/schema.ts";
import { emptyQuota } from "../src/providers/oauth/state.ts";

for (const [type, quotaRoute] of [
  ["claude", claudeQuotaRoute],
  ["xai", xaiQuotaRoute],
]) {
  test(`${type} excludes tried accounts without treating unknown quota as permission for Extra Usage`, async () => {
    const credentials = ["a", "b", "c"].map((id) => ({
      id,
      disabled: false,
      priority: 100,
      auth: { type: "oauth", account_ref: crypto.randomUUID() },
    }));
    const provider = { id: type, type, allow_extra_usage: true, credentials };
    const route = {
      requestedModel: "model",
      targets: [
        {
          provider,
          credentials: credentials.slice(0, 2),
          upstreamModel: "model",
          routeApplied: false,
        },
      ],
    };
    const quota = {
      ...emptyQuota(),
      updated_at: Date.now(),
      stale: false,
      groups: [
        {
          id: "subscription",
          label: "Subscription",
          model: null,
          buckets: [
            {
              id: "daily",
              label: "Daily",
              window: "daily",
              used_percent: 100,
              remaining_fraction: 0,
              reset_at: new Date(Date.now() + 60000).toISOString(),
            },
          ],
        },
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 0,
        utilization: 0,
      },
    };
    let healthFailure = false;
    const readAccounts = [];
    const env = {
      HEALTH: {
        getByName: (name) => ({
          async getStatus() {
            if (healthFailure && name === `key:${type}:c`)
              throw new Error("unavailable");
            return { failures: 0, cooling_until: null };
          },
        }),
      },
      PROVIDER_OAUTH_ACCOUNT: {
        getByName: (ref) => ({
          async run() {
            readAccounts.push(ref);
            return {
              ok: true,
              data: accountViewSchema.parse({
                account_ref: ref,
                provider_id: type,
                status: "ready",
                email: null,
                project_id: null,
                expires_at: null,
                error: null,
                models: [],
                models_updated_at: null,
                models_error: null,
                quota:
                  ref === credentials[2].auth.account_ref
                    ? emptyQuota()
                    : quota,
              }),
            };
          },
        }),
      },
    };
    const excluded = new Set([`${type}\0a`]);
    const selectedIds = (result) =>
      result.route.targets[0].credentials.map((credential) => credential.id);
    assert.deepEqual(selectedIds(await quotaRoute(env, route, excluded)), [
      "b",
    ]);
    assert.equal(readAccounts.includes(credentials[0].auth.account_ref), false);
    provider.allow_extra_usage = false;
    assert.deepEqual(selectedIds(await quotaRoute(env, route, excluded)), []);
    provider.allow_extra_usage = true;
    route.targets[0].credentials = credentials;
    for (const failure of [false, true]) {
      healthFailure = failure;
      const result = await quotaRoute(env, route, excluded);
      assert.deepEqual(selectedIds(result), []);
      assert.equal(result.allBlocked, false);
    }
  });
}
