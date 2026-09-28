import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config/store.ts";
import {
  configurationSchema,
  draftConfigurationSchema,
} from "../src/config/schema.ts";
import { codexAdapter } from "../src/providers/codex/index.ts";
import {
  authorizationUrl,
  CodexClient,
  creditAvailable,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  parseIdToken,
  parseModels,
  parseResetCredits,
  parseUsage,
} from "../src/providers/codex/api.ts";
import {
  codexUsageLimit,
  codexUsageLimitEvent,
  codexUsageLimitFromError,
  codexUsageLimitResponse,
  DEFAULT_QUOTA_COOLDOWN_MS,
} from "../src/providers/codex/limits.ts";
import { aggregateCodexModels } from "../src/gateway/catalog/models.ts";

const ref = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = Date.UTC(2026, 8, 28, 12);

function config(overrides = {}) {
  return parseConfig({
    providers: [
      {
        type: "codex",
        id: "codex",
        models: ["gpt-5.5-codex"],
        priority: 100,
        disabled: false,
        credentials: [
          {
            id: "one",
            auth: { type: "oauth", account_ref: ref },
            priority: 100,
            disabled: false,
          },
        ],
        ...overrides,
      },
    ],
    api_keys: [{ id: "client", api_key: "client-key", providers: ["codex"] }],
  });
}
function jwt(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}
const credential = {
  type: "oauth",
  provider: "codex",
  account_ref: ref,
  token: "account-access-token",
  account_id: "workspace-account",
};

test("Codex defaults to round robin with WebSocket and search, and no automatic resets", () => {
  const [provider] = config().providers;
  assert.equal(provider.account_selection, "round_robin");
  assert.equal(provider.auto_consume_resets, false);
  assert.equal(provider.supports_websocket, true);
  assert.equal(provider.supports_web_search, true);
  assert.equal(provider.supports_context_management, false);
  assert.equal(
    config({ account_selection: "session_affinity" }).providers[0]
      .account_selection,
    "session_affinity",
  );
  assert.throws(() => config({ account_selection: "random" }));
});

test("Codex is a reserved singleton that rejects gateway-only fields", () => {
  const value = config();
  for (const schema of [configurationSchema, draftConfigurationSchema]) {
    const renamed = structuredClone(value);
    renamed.providers[0].id = "chatgpt";
    assert.equal(schema.safeParse(renamed).success, false);
    assert.throws(
      () =>
        schema.parse({
          ...value,
          providers: [...value.providers, ...value.providers],
        }),
      /Codex is a fixed provider/,
    );
    const gateway = structuredClone(value);
    gateway.providers[0] = {
      ...gateway.providers[0],
      type: "ai_gateway",
      base_url: "https://example.test",
      account_selection: undefined,
      auto_consume_resets: undefined,
      credentials: [
        {
          id: "key",
          auth: { type: "api_key", api_key: "upstream" },
          priority: 100,
          disabled: false,
        },
      ],
    };
    assert.equal(schema.safeParse(gateway).success, false);
  }
  for (const field of [
    { base_url: "https://chatgpt.example" },
    { protocol: "openai" },
    { anthropic_1m_context: true },
    { emulate_claude_code: true },
  ])
    assert.throws(() => config(field));
  assert.throws(
    () =>
      config({
        credentials: [
          {
            id: "one",
            auth: { type: "api_key", api_key: "sk-openai" },
            priority: 100,
            disabled: false,
          },
        ],
      }),
    /oauth|auth/i,
  );
});

test("an enabled Codex needs models and an account, a disabled one does not", () => {
  const disabled = config({ disabled: true, models: [], credentials: [] });
  assert.equal(disabled.providers[0].disabled, true);
  assert.throws(
    () => config({ credentials: [] }),
    /add a Codex account before enabling/,
  );
  assert.throws(() => config({ models: [] }), /select Codex models/);
});

test("the adapter forwards Codex requests with only the account token and workspace", async () => {
  const [provider] = config().providers;
  const request = new Request("https://gateway/v1/responses?trace=1", {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "x-api-key": "client-key",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      session_id: "session-1",
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.999.0",
    },
    body: JSON.stringify({ model: "gpt-5.5-codex", input: [] }),
  });
  const prepared = await codexAdapter.prepare(provider, credential, {
    request,
    endpoint: "responses",
    transport: "http",
    protocol: "openai",
  });
  assert.equal(
    prepared.url,
    "https://chatgpt.com/backend-api/codex/responses?trace=1",
  );
  assert.equal(
    prepared.headers.get("authorization"),
    "Bearer account-access-token",
  );
  assert.equal(prepared.headers.get("chatgpt-account-id"), "workspace-account");
  assert.equal(prepared.headers.get("x-api-key"), null);
  for (const name of [
    "openai-beta",
    "session_id",
    "originator",
    "user-agent",
    "content-type",
  ])
    assert.equal(prepared.headers.get(name), request.headers.get(name), name);
  assert.equal(prepared.body, undefined);
  assert.equal(prepared.transformResponse, undefined);
});

test("the adapter serves Codex endpoints and gates optional capabilities", () => {
  const [provider] = config().providers;
  for (const endpoint of [
    "responses",
    "responses/compact",
    "images/generations",
    "images/edits",
    "memories/trace_summarize",
    "models",
    "alpha/search",
  ])
    assert.equal(codexAdapter.supports(provider, endpoint, "http"), true);
  for (const endpoint of ["chat/completions", "messages", "embeddings"])
    assert.equal(codexAdapter.supports(provider, endpoint, "http"), false);
  assert.equal(codexAdapter.supports(provider, "responses", "websocket"), true);
  assert.equal(
    codexAdapter.supports(provider, "responses/compact", "websocket"),
    false,
  );
  const limited = config({
    supports_websocket: false,
    supports_web_search: false,
  }).providers[0];
  assert.equal(codexAdapter.supports(limited, "responses", "websocket"), false);
  assert.equal(codexAdapter.supports(limited, "alpha/search", "http"), false);
  assert.equal(
    codexAdapter.supports(provider, "alpha/history/v2/list_items", "http"),
    false,
  );
  const managed = config({ supports_context_management: true }).providers[0];
  assert.equal(
    codexAdapter.supports(managed, "alpha/history/v2/list_items", "http"),
    true,
  );
});

test("the model list keeps each account ModelInfo and adds a client version", async () => {
  const [provider] = config().providers;
  const prepared = await codexAdapter.prepare(provider, credential, {
    request: new Request("https://gateway/v1/models"),
    endpoint: "models",
    transport: "http",
    protocol: "openai",
  });
  assert.equal(
    new URL(prepared.url).searchParams.get("client_version"),
    "0.999.0",
  );
  const kept = await codexAdapter.prepare(provider, credential, {
    request: new Request("https://gateway/v1/models?client_version=1.2.3"),
    endpoint: "models",
    transport: "http",
    protocol: "openai",
  });
  assert.equal(new URL(kept.url).searchParams.get("client_version"), "1.2.3");
  const info = {
    slug: "gpt-5.5-codex",
    display_name: "GPT-5.5 Codex",
    context_window: 272000,
    input_modalities: ["text", "image"],
    shell_type: "shell_command",
  };
  assert.deepEqual(
    prepared.parseModels({ models: [info, { display_name: "no slug" }] }),
    {
      data: [
        {
          id: "gpt-5.5-codex",
          object: "model",
          owned_by: "codex",
          display_name: "GPT-5.5 Codex",
          context_window: 272000,
          input_modalities: ["text", "image"],
          codex: info,
        },
      ],
    },
  );
  const [aggregated] = aggregateCodexModels(
    new Set(["gpt-5.5-codex"]),
    new Set(),
    [],
    prepared.parseModels({ models: [info] }).data,
  );
  assert.deepEqual(aggregated, info);
});

test("authorization uses the Codex CLI public client and localhost callback", () => {
  const url = new URL(authorizationUrl("state-1", "challenge-1"));
  assert.equal(
    url.origin + url.pathname,
    "https://auth.openai.com/oauth/authorize",
  );
  assert.equal(url.searchParams.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), CODEX_REDIRECT_URI);
  assert.equal(CODEX_REDIRECT_URI, "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-1");
});

test("the ID token supplies the email, workspace account and plan", () => {
  const identity = parseIdToken(
    jwt({
      email: "user@example.test",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-account",
        chatgpt_user_id: "user-1",
        chatgpt_plan_type: "prolite",
        chatgpt_subscription_active_until: 1790000000,
      },
    }),
  );
  assert.deepEqual(identity, {
    email: "user@example.test",
    account_id: "workspace-account",
    user_id: "user-1",
    plan_type: "prolite",
    subscription_active_until: new Date(1790000000 * 1000).toISOString(),
  });
  assert.throws(
    () => parseIdToken(jwt({ email: "user@example.test" })),
    /workspace account/,
  );
});

test("usage maps rate-limit windows, credits and resets to the quota snapshot", () => {
  const usage = parseUsage({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 88,
        limit_window_seconds: 18000,
        reset_at: 1790000000,
      },
      secondary_window: {
        used_percent: 25,
        limit_window_seconds: 604800,
        reset_after_seconds: 60,
      },
    },
    code_review_rate_limit: {
      limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 2592000 },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.5 Pro",
        metered_feature: "gpt_pro",
        normal_model_slug: "gpt-5.5-pro",
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 86400 },
        },
      },
    ],
    credits: { has_credits: true, unlimited: false, balance: 12.5 },
    rate_limit_reset_credits: { available_count: 3 },
  });
  assert.equal(usage.plan_type, "plus");
  assert.equal(usage.limit_reached, false);
  assert.deepEqual(
    usage.groups.map((group) => [
      group.id,
      group.limit_reached,
      group.model,
      group.buckets.map((bucket) => [
        bucket.window,
        bucket.label,
        Number(bucket.remaining_fraction.toFixed(2)),
      ]),
    ]),
    [
      [
        "codex",
        false,
        null,
        [
          ["5h", "5-hour limit", 0.12],
          ["weekly", "Weekly limit", 0.75],
        ],
      ],
      ["code_review", true, null, [["monthly", "Monthly limit", 0]]],
      ["gpt_pro", false, "gpt-5.5-pro", [["1d", "1d limit", 0.9]]],
    ],
  );
  assert.equal(
    usage.groups[0].buckets[0].reset_at,
    new Date(1790000000 * 1000).toISOString(),
  );
  assert.deepEqual(usage.credits_balance, {
    has_credits: true,
    unlimited: false,
    balance: "12.5",
  });
  assert.equal(usage.available_resets, 3);
  assert.equal(
    parseUsage({ rate_limit: { allowed: false } }).limit_reached,
    true,
  );
  assert.throws(() => parseUsage({ unexpected: true }), /rate-limit status/);
});

test("reset credits and models tolerate partial upstream records", () => {
  assert.deepEqual(
    parseResetCredits({
      credits: [
        {
          id: "credit-1",
          expires_at: "2026-10-01T00:00:00Z",
          status: "available",
        },
        { expires_at: "no id" },
      ],
    }),
    {
      available_count: 1,
      credits: [
        {
          id: "credit-1",
          reset_type: null,
          status: "available",
          granted_at: null,
          expires_at: "2026-10-01T00:00:00Z",
          title: null,
          description: null,
        },
      ],
    },
  );
  assert.equal(
    parseResetCredits({ available_count: 4, credits: [] }).available_count,
    4,
  );
  assert.deepEqual(
    parseModels({
      models: [
        {
          slug: "gpt-5.5-codex",
          context_window: 272000,
          input_modalities: ["text", "image"],
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    }),
    [
      {
        id: "gpt-5.5-codex",
        display_name: "gpt-5.5-codex",
        input_token_limit: 272000,
        output_token_limit: null,
        supports_thinking: true,
        supports_images: true,
      },
    ],
  );
  assert.throws(() => parseModels({}), /no model list/);
});

test("quota exhaustion is recognised from the error and its reset time", () => {
  const none = () => null;
  assert.deepEqual(
    codexUsageLimitFromError(
      { error: { type: "usage_limit_reached", resets_at: now / 1000 + 600 } },
      none,
      now,
    ),
    { code: "usage_limit_reached", resets_at: now + 600_000 },
  );
  assert.deepEqual(
    codexUsageLimitFromError(
      { error: { code: "insufficient_quota", resets_in_seconds: 30 } },
      none,
      now,
    ),
    { code: "insufficient_quota", resets_at: now + 30_000 },
  );
  // The exhausted window from the active limit's header family wins.
  const headers = new Headers({
    "x-codex-active-limit": "codex_other",
    "x-codex-other-primary-used-percent": "100",
    "x-codex-other-primary-reset-at": String(now / 1000 + 120),
    "x-codex-other-secondary-used-percent": "40",
    "x-codex-other-secondary-reset-at": String(now / 1000 + 9000),
  });
  assert.deepEqual(
    codexUsageLimitFromError(
      { error: { type: "usage_limit_reached" } },
      (name) => headers.get(name),
      now,
    ),
    { code: "usage_limit_reached", resets_at: now + 120_000 },
  );
  assert.deepEqual(
    codexUsageLimitFromError(
      { error: { type: "usage_limit_reached", resets_at: now / 1000 - 5 } },
      none,
      now,
    ),
    {
      code: "usage_limit_reached",
      resets_at: now + DEFAULT_QUOTA_COOLDOWN_MS,
    },
  );
  assert.equal(
    codexUsageLimitFromError(
      { error: { type: "usage_not_included" } },
      none,
      now,
    ).code,
    "usage_not_included",
  );
  for (const payload of [
    { error: { type: "rate_limit_exceeded" } },
    { error: "usage_limit_reached" },
    { message: "no error" },
    null,
  ])
    assert.equal(codexUsageLimitFromError(payload, none, now), undefined);
});

test("HTTP detection reads only 429 bodies and leaves the response intact", async () => {
  const body = JSON.stringify({
    error: { type: "usage_limit_reached", resets_in_seconds: 60 },
  });
  const response = new Response(body, { status: 429 });
  assert.deepEqual(await codexUsageLimit(response, now), {
    code: "usage_limit_reached",
    resets_at: now + 60_000,
  });
  assert.equal(await response.text(), body);
  assert.equal(
    await codexUsageLimit(new Response(body, { status: 500 }), now),
    undefined,
  );
  assert.equal(
    await codexUsageLimit(new Response("not json", { status: 429 }), now),
    undefined,
  );
});

test("an all-accounts-exhausted reply tells Codex when usage returns", async () => {
  const response = codexUsageLimitResponse(now + 90_500, "request-1", now);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "91");
  assert.equal(response.headers.get("x-request-id"), "request-1");
  const { error } = await response.json();
  assert.equal(error.type, "usage_limit_reached");
  assert.equal(error.resets_at, Math.ceil((now + 90_500) / 1000));
  assert.equal(error.resets_in_seconds, 91);
  const event = JSON.parse(codexUsageLimitEvent(now + 1000, now));
  assert.equal(event.type, "error");
  assert.equal(event.status, 429);
  assert.equal(event.error.type, "usage_limit_reached");
  // The WebSocket event classifies the same way the HTTP body does.
  assert.equal(
    codexUsageLimitFromError(event, () => null, now).resets_at,
    now + 1000,
  );
});

test("only explicit available reset credits can be spent", () => {
  for (const status of [
    null,
    "",
    "redeeming",
    "redeemed",
    "expired",
    "unknown",
  ])
    assert.equal(creditAvailable({ status }), false);
  assert.equal(creditAvailable({ status: "available" }), true);
});

test("quota switching uses only configured Codex exhaustion codes and the common fallback", () => {
  for (const type of [
    "usage_limit_reached",
    "usage_not_included",
    "insufficient_quota",
  ])
    assert.deepEqual(
      codexUsageLimitFromError({ error: { type } }, () => null, now),
      {
        code: type,
        resets_at: now + DEFAULT_QUOTA_COOLDOWN_MS,
      },
    );
  for (const code of [
    "credit_balance_exhausted",
    "organization_usage_limit_exceeded",
    "rate_limit_exceeded",
  ])
    assert.equal(
      codexUsageLimitFromError({ error: { code } }, () => null, now),
      undefined,
    );
});

test("refresh invalid_grant requires HTTP 400 before marking reauthorization", async () => {
  for (const [status, code, permanent] of [
    [400, "invalid_grant", true],
    [500, "invalid_grant", false],
    [429, "INVALID_GRANT", false],
    [401, "other", true],
    [403, "refresh_token_expired", true],
  ]) {
    const client = new CodexClient(async () =>
      Response.json({ error: code }, { status }),
    );
    await assert.rejects(client.refresh("mock-refresh"), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code === "invalid_grant", permanent);
      return true;
    });
  }
});

test("Codex identities can omit email and carry the FedRAMP account claim", () => {
  const identity = parseIdToken(
    jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace",
        chatgpt_account_is_fedramp: true,
      },
    }),
  );
  assert.equal(identity.email, null);
  assert.equal(identity.account_id, "workspace");
  assert.equal(identity.is_fedramp, true);
});

test("partial token refreshes preserve omitted fields and the existing expiry", async () => {
  const previous = {
    access_token: "old-access",
    refresh_token: "old-refresh",
    id_token: "old-id",
    expires_at: 1234,
  };
  const client = new CodexClient(async () =>
    Response.json({ refresh_token: "rotated-refresh" }),
  );
  assert.deepEqual(await client.refresh("old-refresh", previous), {
    ...previous,
    refresh_token: "rotated-refresh",
  });
  const newAccess = jwt({ exp: 1900000000 });
  const updated = await new CodexClient(async () =>
    Response.json({ access_token: newAccess }),
  ).refresh("old-refresh", previous);
  assert.deepEqual(updated, {
    ...previous,
    access_token: newAccess,
    expires_at: 1900000000000,
  });
});

test("FedRAMP headers follow the selected account for HTTP and WebSocket", async () => {
  const [provider] = config().providers;
  for (const transport of ["http", "websocket"]) {
    for (const is_fedramp of [false, true]) {
      const prepared = await codexAdapter.prepare(
        provider,
        {
          type: "oauth",
          provider: "codex",
          token: "token",
          account_id: "workspace",
          account_ref: ref,
          is_fedramp,
        },
        {
          request: new Request("https://gateway.test/responses", {
            headers: { "x-openai-fedramp": "true" },
          }),
          endpoint: "responses",
          transport,
          protocol: "openai",
        },
      );
      assert.equal(
        prepared.headers.get("x-openai-fedramp"),
        is_fedramp ? "true" : null,
      );
    }
  }
  const headers = [];
  const client = new CodexClient(
    async (request) => {
      headers.push(request.headers);
      return Response.json({});
    },
    undefined,
    true,
  );
  await client.usage("token", "workspace");
  await client.models("token", "workspace");
  await client.resetCredits("token", "workspace");
  for (const header of headers)
    assert.equal(header.get("x-openai-fedramp"), "true");
});

test("authorization rejects incomplete tokens instead of reusing an old refresh token", async () => {
  const client = new CodexClient(async () =>
    Response.json({ access_token: "access", id_token: "identity" }),
  );
  await assert.rejects(client.exchange("code", "verifier", CODEX_REDIRECT_URI));
  const token = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "workspace" },
  });
  assert.throws(
    () => parseIdToken(token.split(".").slice(0, 2).join(".")),
    /workspace account/,
  );
});
