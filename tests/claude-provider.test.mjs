import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config/store.ts";
import { editableConfigurationSchema } from "../src/config/schema.ts";
import { claudeAdapter } from "../src/providers/claude/index.ts";
import {
  authorizationUrl,
  parseUsage,
  parseProfile,
  parseModels,
  ClaudeClient,
} from "../src/providers/claude/api.ts";
import {
  quotaAvailability,
  claudeUsageLimit,
  headerQuota,
} from "../src/providers/claude/limits.ts";
const ref = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function config(extra = {}) {
  return parseConfig({
    providers: [
      {
        type: "claude",
        id: "claude",
        models: ["claude-sonnet-4-6"],
        credentials: [
          {
            id: "one",
            auth: { type: "oauth", account_ref: ref },
            priority: 100,
            disabled: false,
          },
        ],
        disabled: false,
        priority: 100,
        ...extra,
      },
    ],
    api_keys: [{ id: "client", api_key: "secret", providers: ["claude"] }],
  });
}
test("Claude is an OAuth singleton with no resets or auxiliary transports", () => {
  const p = config().providers[0];
  assert.equal(p.account_selection, "round_robin");
  assert.equal(p.allow_extra_usage, false);
  for (const extra of [
    { id: "other" },
    { base_url: "https://example.com" },
    { auto_consume_resets: true },
    { supports_websocket: true },
    { emulate_claude_code: true },
    { anthropic_1m_context: true },
    { protocol: "anthropic" },
    { credentials: [] },
  ])
    assert.throws(() => config(extra));
  const draft = config();
  draft.providers[0].credentials = [];
  assert.equal(editableConfigurationSchema.safeParse(draft).success, true);
  const duplicate = config();
  duplicate.providers.push(duplicate.providers[0]);
  assert.throws(() => parseConfig(duplicate));
  assert.equal(
    config({ disabled: true, models: [], credentials: [] }).providers[0]
      .disabled,
    true,
  );
});
test("Claude adapter preserves original request and application headers", async () => {
  const body =
    ' { "model":"claude-sonnet-4-6", "system": [{"type":"text","text":"original"}], "unknown":true } ';
  const request = new Request(
    "https://gateway.test/v1/messages?beta=true&x=1&x=2",
    {
      method: "POST",
      headers: {
        authorization: "Bearer client",
        "x-api-key": "client",
        "anthropic-beta": "custom",
        "user-agent": "original",
        "anthropic-version": "2023-06-01",
      },
      body,
    },
  );
  const prepared = claudeAdapter.prepare(
    config().providers[0],
    { token: "upstream", generation: 1 },
    { request, endpoint: "messages", transport: "http" },
  );
  assert.equal(
    prepared.url,
    "https://api.anthropic.com/v1/messages?beta=true&x=1&x=2",
  );
  assert.equal(prepared.headers.get("authorization"), "Bearer upstream");
  assert.equal(prepared.headers.has("x-api-key"), false);
  assert.equal(prepared.headers.get("anthropic-beta"), "custom");
  assert.equal(prepared.headers.get("user-agent"), "original");
  assert.equal(prepared.body, undefined);
  assert.equal(await request.text(), body);
  for (const endpoint of ["messages", "messages/count_tokens", "models"])
    assert.equal(
      claudeAdapter.supports(config().providers[0], endpoint, "http"),
      true,
    );
  assert.equal(
    claudeAdapter.supports(config().providers[0], "messages", "websocket"),
    false,
  );
});
test("Claude usage distinguishes model and global windows, expired windows and stale snapshots", () => {
  const now = Date.now(),
    at = (ms) => new Date(now + ms).toISOString();
  const quota = {
    ...parseUsage({
      five_hour: { utilization: 20, resets_at: at(10000) },
      seven_day_opus: { utilization: 100, resets_at: at(20000) },
    }),
    updated_at: now,
    stale: false,
  };
  assert.equal(
    quotaAvailability(quota, "claude-sonnet-4-6", now).subscription,
    true,
  );
  assert.equal(
    quotaAvailability(quota, "claude-opus-4-6", now).until,
    now + 20000,
  );
  assert.equal(
    quotaAvailability({ ...quota, stale: true }, "claude-sonnet-4-6", now)
      .subscription,
    false,
  );
  quota.groups[0].buckets[0].used_percent = 100;
  assert.equal(
    quotaAvailability(quota, "claude-opus-4-6", now).until,
    now + 20000,
  );
  assert.equal(
    quotaAvailability(quota, "claude-sonnet-4-6", now + 11000).subscription,
    true,
  );
  assert.throws(() => parseUsage({}));
});
test("Extra usage requires confirmed remaining balance", () => {
  const quota = {
    ...parseUsage({
      five_hour: {
        utilization: 100,
        resets_at: new Date(Date.now() + 60000).toISOString(),
      },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 1000,
        used_credits: 200,
        utilization: 20,
      },
    }),
    updated_at: Date.now(),
    stale: false,
  };
  assert.equal(quotaAvailability(quota, "sonnet").extra, true);
  quota.extra_usage.used_credits = 1000;
  assert.equal(quotaAvailability(quota, "sonnet").extra, false);
});
test("Generic 429 is not a quota switch and response utilization uses fractions", () => {
  assert.equal(
    claudeUsageLimit(new Response("", { status: 429 }), "sonnet"),
    undefined,
  );
  const now = Date.now();
  const response = new Response("", {
    status: 429,
    headers: {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
      "anthropic-ratelimit-unified-reset": String((now + 60000) / 1000),
    },
  });
  assert.deepEqual(claudeUsageLimit(response, "claude-opus-4-6", now), {
    model: "opus",
    until: now + 60000,
  });
  assert.equal(
    headerQuota(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.75",
        "anthropic-ratelimit-unified-5h-reset": "1800000000",
      }),
    )[0].buckets[0].used_percent,
    75,
  );
});
test("OAuth uses public PKCE and validates profile identity", async () => {
  const url = new URL(authorizationUrl("state", "challenge"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state");
  const profile = parseProfile({
    account: { uuid: "a", email: "a@example.test" },
    organization: {
      uuid: "org",
      organization_type: "claude_max",
      rate_limit_tier: "default_claude_max_5x",
    },
  });
  assert.equal(profile.identity.id, "a:org");
  assert.throws(() => parseProfile({ account: { uuid: "a" } }));
  const calls = [];
  const client = new ClaudeClient(async (request) => {
    calls.push(JSON.parse(await request.text()));
    return Response.json({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "user:inference user:profile",
    });
  }, new AbortController().signal);
  await client.exchange("code", "verifier", "state");
  assert.equal(calls[0].state, "state");
  assert.equal(calls[0].code_verifier, "verifier");
});

test("Unknown applicable windows never count as subscription capacity", () => {
  const quota = {
    ...parseUsage({
      five_hour: { utilization: null, resets_at: null },
      seven_day_opus: { utilization: 20, resets_at: null },
    }),
    updated_at: Date.now(),
    stale: false,
  };
  assert.equal(
    quotaAvailability(quota, "claude-sonnet-4-6").subscription,
    false,
  );
  assert.equal(quotaAvailability(quota, "claude-opus-4-6").subscription, false);
});

test("Desktop unlimited Extra Usage is available unless explicitly disabled upstream", () => {
  const quota = {
    ...parseUsage({
      five_hour: {
        utilization: 100,
        resets_at: new Date(Date.now() + 60000).toISOString(),
      },
      extra_usage: {
        is_enabled: true,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        disabled_reason: null,
      },
    }),
    updated_at: Date.now(),
    stale: false,
  };
  assert.equal(quotaAvailability(quota, "claude-sonnet-4-6").extra, true);
  quota.extra_usage.disabled_reason = "out_of_credits";
  assert.equal(quotaAvailability(quota, "claude-sonnet-4-6").extra, false);
});
test("Current usage limits include canonical global and model-scoped windows", () => {
  const now = Date.now(),
    reset = new Date(now + 60000).toISOString();
  const quota = {
    ...parseUsage({
      limits: [
        { kind: "session", percent: 20, resets_at: reset },
        { kind: "weekly_all", group: "weekly", percent: 30, resets_at: reset },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 100,
          resets_at: reset,
          scope: { model: { id: "claude-opus-4-6", display_name: "Opus 4.6" } },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 100,
          is_active: false,
          scope: { model: { id: "claude-sonnet-4-6" } },
        },
      ],
    }),
    updated_at: now,
    stale: false,
  };
  assert.equal(
    quotaAvailability(quota, "claude-sonnet-4-6", now).subscription,
    true,
  );
  assert.equal(
    quotaAvailability(quota, "claude-opus-4-6", now).until,
    now + 60000,
  );
  assert.throws(() =>
    parseUsage({
      five_hour: { utilization: 0, resets_at: reset },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 100,
          scope: { model: { display_name: "Unknown" } },
        },
      ],
    }),
  );
});
test("Independent rejected windows retain their own scopes and recovery times", () => {
  const now = Date.now(),
    headers = new Headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String((now + 60000) / 1000),
    });
  assert.deepEqual(
    claudeUsageLimit(
      new Response(null, { status: 429, headers }),
      "claude-opus-4-6",
      now,
    ),
    { model: null, until: now + 60000 },
  );
  headers.set("anthropic-ratelimit-unified-status", "rejected");
  headers.set(
    "anthropic-ratelimit-unified-representative-claim",
    "seven_day_opus",
  );
  headers.set(
    "anthropic-ratelimit-unified-reset",
    String((now + 120000) / 1000),
  );
  assert.deepEqual(
    claudeUsageLimit(
      new Response(null, { status: 429, headers }),
      "claude-opus-4-6",
      now,
    ),
    {
      model: "opus",
      until: now + 120000,
      additional_limits: [{ model: null, until: now + 60000 }],
    },
  );
  assert.equal(
    claudeUsageLimit(
      new Response(null, {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "overage",
        },
      }),
      "claude-opus-4-6",
      now,
    ),
    undefined,
  );
});

test("Claude model capabilities use upstream token fields", () => {
  assert.deepEqual(
    parseModels({
      data: [
        {
          id: "claude-opus-4-6",
          display_name: "Opus",
          max_input_tokens: 200000,
          max_tokens: 128000,
        },
      ],
    }).map((model) => [model.input_token_limit, model.output_token_limit]),
    [[200000, 128000]],
  );
});

test("Refresh identity is validated from the grant without another profile request", async () => {
  const calls = [];
  const client = new ClaudeClient(async (request) => {
    calls.push(request.url);
    return Response.json({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      account: { uuid: "account" },
      organization: { uuid: "org" },
    });
  }, new AbortController().signal);
  const tokens = await client.refresh("old-refresh", {
    account_id: "account",
    organization_id: "org",
  });
  assert.equal(tokens.refresh_token, "rotated-refresh");
  assert.equal(calls.length, 1);
  await assert.rejects(
    client.refresh("old-refresh", {
      account_id: "other",
      organization_id: "org",
    }),
    /another Claude account/,
  );
});

test("Repeated scoped windows use the newest reset interval", () => {
  const now = Date.now();
  const scope = { model: { id: "claude-opus-4-6" } };
  const quota = {
    ...parseUsage({
      five_hour: {
        utilization: 10,
        resets_at: new Date(now + 60000).toISOString(),
      },
      limits: [
        {
          kind: "weekly_scoped",
          scope,
          percent: 100,
          resets_at: new Date(now + 10000).toISOString(),
        },
        {
          kind: "weekly_scoped",
          scope,
          percent: 20,
          resets_at: new Date(now + 120000).toISOString(),
        },
      ],
    }),
    updated_at: now,
    stale: false,
  };
  assert.equal(
    quotaAvailability(quota, "claude-opus-4-6", now).subscription,
    true,
  );
});
