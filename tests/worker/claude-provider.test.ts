import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  runDurableObjectAlarm,
  waitOnExecutionContext,
  evictDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { parseConfig } from "../../src/config/store.ts";
import { handleInference } from "../../src/gateway/http/proxy.ts";
import {
  accountReply,
  accountViewSchema,
  sessionViewSchema,
} from "../../src/providers/oauth/schema.ts";
const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const sent: { token: string; body: string; headers: Headers }[] = [];
const counted: { url: string; body: string; headers: Headers }[] = [];
const usage = new Map<string, number>();
const reject = new Set<string>();
let generic429 = false;
let stream = false;
let usageFails = false;
let tokenLifetime = 3600;
let refreshFails = false;
let partialRefresh = false;
let countTokensRejected = false;
let messageHeaders: Record<string, string> = {};
beforeAll(() => applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  counted.length = 0;
  usage.clear();
  reject.clear();
  generic429 = false;
  stream = false;
  usageFails = false;
  tokenLifetime = 3600;
  refreshFails = false;
  partialRefresh = false;
  countTokensRejected = false;
  messageHeaders = {};
  await env.CODY_CONFIG_KV.delete("gateway-config");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const token =
        request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
      if (url.pathname === "/v1/oauth/token") {
        const body = (await request.json()) as {
          code?: string;
          refresh_token?: string;
        };
        if (body.refresh_token && refreshFails)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const id = body.code ?? body.refresh_token;
        return Response.json({
          access_token: id,
          refresh_token: id,
          expires_in: tokenLifetime,
          ...(body.refresh_token && partialRefresh
            ? {
                refresh_token: null,
                account: null,
                organization: null,
                scope: null,
              }
            : {}),
        });
      }
      if (url.pathname === "/api/oauth/profile")
        return Response.json({
          account: { uuid: token, email: `${token}@example.test` },
          organization: {
            uuid: "org",
            name: "Personal",
            organization_type: "claude_max",
            rate_limit_tier: "max_5x",
          },
        });
      if (url.pathname === "/api/oauth/usage")
        return usageFails
          ? new Response("unavailable", { status: 503 })
          : Response.json({
              five_hour: {
                utilization: usage.get(token) ?? 0,
                resets_at: new Date(Date.now() + 600000).toISOString(),
              },
              extra_usage: {
                is_enabled: true,
                monthly_limit: 1000,
                used_credits: 10,
                utilization: 1,
              },
            });
      if (url.pathname === "/v1/models")
        return Response.json({
          data: [{ id: "claude-sonnet-4-6", display_name: "Sonnet" }],
        });
      if (url.pathname === "/v1/messages/count_tokens") {
        counted.push({
          url: request.url,
          body: await request.text(),
          headers: request.headers,
        });
        return countTokensRejected
          ? Response.json(
              {
                type: "error",
                error: {
                  type: "rate_limit_error",
                  message: "token counting limit",
                },
              },
              { status: 429, headers: messageHeaders },
            )
          : Response.json({ input_tokens: 42 });
      }
      if (url.pathname === "/v1/messages") {
        sent.push({
          token,
          body: await request.text(),
          headers: request.headers,
        });
        if (generic429)
          return Response.json(
            {
              type: "error",
              error: { type: "rate_limit_error", message: "slow down" },
            },
            { status: 429 },
          );
        if (reject.has(token))
          return Response.json(
            {
              type: "error",
              error: { type: "rate_limit_error", message: "quota exhausted" },
            },
            {
              status: 429,
              headers: {
                "anthropic-ratelimit-unified-status": "rejected",
                "anthropic-ratelimit-unified-representative-claim":
                  "seven_day_opus",
                "anthropic-ratelimit-unified-reset": String(
                  Math.ceil(Date.now() / 1000) + 600,
                ),
                ...messageHeaders,
              },
            },
          );
        if (stream)
          return new Response(
            'event: message_start\ndata: {"type":"message_start"}\n\nevent: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n',
            {
              headers: {
                "content-type": "text/event-stream",
                ...messageHeaders,
              },
            },
          );
        return Response.json({ token }, { headers: messageHeaders });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function ready() {
  const ref = crypto.randomUUID(),
    id = crypto.randomUUID();
  const stub = env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
  const session = await accountReply(
    stub.run({
      action: "start",
      account_ref: ref,
      actor: "admin",
      provider_type: "claude",
      connection: { provider_id: "claude", credential_id: id },
    }),
    sessionViewSchema,
  );
  const state = new URL(session.url!).searchParams.get("state")!;
  await accountReply(
    stub.run({
      action: "complete",
      actor: "admin",
      session_id: session.id.split(".")[1],
      redirect_url: `${id}#${state}`,
    }),
    sessionViewSchema,
  );
  for (let i = 0; i < 5; i++) {
    await runDurableObjectAlarm(stub);
    const view = await accountReply(
      stub.run({ action: "view" }),
      accountViewSchema,
    );
    if (view.status === "ready") return { ref, id, stub };
  }
  throw new Error("Authorization failed");
}
function config(accounts: { ref: string; id: string }[], extra = {}) {
  return parseConfig({
    providers: [
      {
        type: "claude",
        id: "claude",
        priority: 100,
        disabled: false,
        models: ["claude-sonnet-4-6", "claude-opus-4-6"],
        credentials: accounts.map((a) => ({
          id: a.id,
          auth: { type: "oauth", account_ref: a.ref },
          priority: 100,
          disabled: false,
        })),
        ...extra,
      },
    ],
    api_keys: [{ id: "client", api_key: "secret", providers: ["claude"] }],
  });
}
async function infer(
  c: ReturnType<typeof config>,
  session = crypto.randomUUID(),
  model = "claude-sonnet-4-6",
  endpoint: "messages" | "messages/count_tokens" = "messages",
) {
  const context = createExecutionContext();
  const response = await handleInference(
    new Request(`https://gateway.test/v1/${endpoint}?beta=true`, {
      method: "POST",
      headers: {
        "x-api-key": "secret",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "custom",
        "user-agent": "claude-original",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hello" }],
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        unknown: { keep: true },
      }),
    }),
    env,
    c,
    c.api_keys[0],
    endpoint,
    crypto.randomUUID(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
test("Claude PKCE identity survives eviction and rejects stale observations", async () => {
  const a = await ready();
  const view = await accountReply(
    a.stub.run({ action: "view" }),
    accountViewSchema,
  );
  expect(view.claude?.organization_id).toBe("org");
  await evictDurableObject(a.stub);
  expect(
    (await accountReply(a.stub.run({ action: "view" }), accountViewSchema))
      .claude,
  ).toEqual(view.claude);
  const result = await a.stub.run({
    action: "claude_limit",
    generation: (view.generation ?? 0) - 1,
    model: null,
    until: Date.now() + 60000,
  });
  expect(result.ok).toBe(false);
  expect((await a.stub.run({ action: "reset_credits" })).ok).toBe(false);
});
test("Claude round robin rotates new sessions and pins existing sessions", async () => {
  const accounts = await Promise.all([ready(), ready()]);
  const c = config(accounts);
  const session = crypto.randomUUID();
  const first = await (await infer(c, session)).json();
  expect(await (await infer(c, session)).json()).toEqual(first);
  const next = await (await infer(c)).json();
  expect(next).not.toEqual(first);
  expect(sent[0].headers.get("x-api-key")).toBeNull();
  expect(sent[0].headers.get("anthropic-beta")).toBe("custom");
  expect(sent[0].headers.get("user-agent")).toBe("claude-original");
  expect(JSON.parse(sent[0].body).unknown).toEqual({ keep: true });
});
test("Claude session affinity switches only on explicit quota rejection, with model scope", async () => {
  const [a, b] = await Promise.all([ready(), ready()]);
  const c = config([a, b], { account_selection: "session_affinity" });
  reject.add(a.id);
  expect(
    await (await infer(c, crypto.randomUUID(), "claude-opus-4-6")).json(),
  ).toEqual({ token: b.id });
  expect(sent).toHaveLength(2);
  reject.clear();
  expect(await (await infer(c)).json()).toEqual({ token: a.id });
});
test("subscription-first routing and explicit Extra Usage fallback", async () => {
  const [a, b] = await Promise.all([ready(), ready()]);
  usage.set(a.id, 100);
  const c = config([a, b], { account_selection: "session_affinity" });
  expect(await (await infer(c)).json()).toEqual({ token: b.id });
  usage.set(b.id, 100);
  await b.stub.run({ action: "quota", force: true });
  expect((await infer(c)).status).toBe(429);
  expect(
    (await infer(config([a, b], { allow_extra_usage: true }))).status,
  ).toBe(200);
});
test("unknown quota fails closed and generic 429 never switches", async () => {
  const [a, b] = await Promise.all([ready(), ready()]);
  const c = config([a, b]);
  usageFails = true;
  expect((await infer(c)).status).toBe(503);
  expect(sent).toHaveLength(0);
  usageFails = false;
  tokenLifetime = 3600;
  refreshFails = false;
  generic429 = true;
  expect((await infer(c)).status).toBe(429);
  expect(sent).toHaveLength(1);
});
test("SSE bytes are forwarded without replay after an error event", async () => {
  const c = config(await Promise.all([ready(), ready()]));
  stream = true;
  const response = await infer(c);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(
    'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}',
  );
  expect(sent).toHaveLength(1);
});

test("Concurrent requests establish one binding and quota lookups are coalesced", async () => {
  const c = config(await Promise.all([ready(), ready()]));
  const session = crypto.randomUUID();
  const replies = await Promise.all(
    Array.from({ length: 6 }, async () => (await infer(c, session)).json()),
  );
  for (const reply of replies) expect(reply).toEqual(replies[0]);
});

test("Claude refresh preserves identity and invalid grants require reauthorization", async () => {
  tokenLifetime = 30;
  const a = await ready();
  const command = {
    action: "resolve" as const,
    connection: { provider_id: "claude", credential_id: a.id },
    proxy_configuration: { proxy_groups: [] },
  };
  expect((await a.stub.run(command)).ok).toBe(true);
  refreshFails = true;
  expect((await a.stub.run(command)).ok).toBe(false);
  expect(
    (await accountReply(a.stub.run({ action: "view" }), accountViewSchema))
      .status,
  ).toBe("needs_reauthorization");
});

test("Claude rejects mismatched OAuth state and device authorization", async () => {
  const ref = crypto.randomUUID();
  const stub = env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
  const start = {
    action: "start" as const,
    actor: "admin",
    account_ref: ref,
    provider_type: "claude" as const,
    connection: { provider_id: "claude", credential_id: "one" },
  };
  expect((await stub.run({ ...start, flow: "device" })).ok).toBe(false);
  const session = await accountReply(stub.run(start), sessionViewSchema);
  expect(
    (
      await stub.run({
        action: "complete",
        actor: "admin",
        session_id: session.id.split(".")[1],
        redirect_url: "code#wrong-state",
      })
    ).ok,
  ).toBe(false);
});

test("An existing Claude session keeps its available account when priorities change", async () => {
  const [a, b] = await Promise.all([ready(), ready()]);
  const c = config([a, b], { account_selection: "session_affinity" });
  const session = crypto.randomUUID();
  expect(await (await infer(c, session)).json()).toEqual({ token: a.id });
  c.providers[0].credentials[1].priority = 200;
  expect(await (await infer(c, session)).json()).toEqual({ token: a.id });
  expect(await (await infer(c)).json()).toEqual({ token: b.id });
});

test("Claude count-tokens has independent limits and preserves the native request", async () => {
  const a = await ready();
  const c = config([a]);
  usage.set(a.id, 100);
  expect((await infer(c)).status).toBe(429);
  usageFails = true;
  await a.stub.run({ action: "quota", force: true });
  const response = await infer(
    c,
    crypto.randomUUID(),
    "claude-sonnet-4-6",
    "messages/count_tokens",
  );
  expect(await response.json()).toEqual({ input_tokens: 42 });
  expect(sent).toHaveLength(0);
  expect(counted).toHaveLength(1);
  expect(counted[0].url).toBe(
    "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
  );
  expect(counted[0].headers.get("authorization")).toBe(`Bearer ${a.id}`);
  expect(counted[0].headers.get("anthropic-beta")).toBe("custom");
  expect(JSON.parse(counted[0].body).unknown).toEqual({ keep: true });
});

test("Claude count-tokens rejection neither switches accounts nor cools Messages", async () => {
  const accounts = await Promise.all([ready(), ready()]);
  const c = config(accounts);
  countTokensRejected = true;
  messageHeaders = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": String(
      Math.ceil(Date.now() / 1000) + 600,
    ),
  };
  const response = await infer(
    c,
    crypto.randomUUID(),
    "claude-sonnet-4-6",
    "messages/count_tokens",
  );
  expect(response.status).toBe(429);
  expect(counted).toHaveLength(1);
  for (const account of accounts) {
    const view = await accountReply(
      account.stub.run({ action: "view" }),
      accountViewSchema,
    );
    expect(view.quota.claude_limits ?? []).toEqual([]);
  }
  messageHeaders = {};
  expect((await infer(c)).status).toBe(200);
});

test("Overage-only rejection preserves the upstream error without a subscription switch", async () => {
  const [a, b] = await Promise.all([ready(), ready()]);
  const c = config([a, b], { account_selection: "session_affinity" });
  reject.add(a.id);
  messageHeaders = {
    "anthropic-ratelimit-unified-representative-claim":
      "seven_day_overage_included",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.00",
    "anthropic-ratelimit-unified-7d_oi-status": "rejected",
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "anthropic-ratelimit-unified-overage-disabled-reason":
      "org_spend_cap_reached",
  };
  const response = await infer(c);
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    type: "error",
    error: { type: "rate_limit_error", message: "quota exhausted" },
  });
  expect(sent).toHaveLength(1);
  reject.clear();
  messageHeaders = {};
  expect(await (await infer(c)).json()).toEqual({ token: a.id });
});

test.each([false, true])(
  "HTTP 200 quota observations persist without replay (SSE: %s)",
  async (useStream) => {
    const a = await ready();
    const c = config([a]);
    const until = (Math.ceil(Date.now() / 1000) + 600) * 1000;
    messageHeaders = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
      "anthropic-ratelimit-unified-reset": String(until / 1000),
      "anthropic-ratelimit-unified-overage-status": "allowed",
    };
    stream = useStream;
    const response = await infer(c, crypto.randomUUID(), "claude-opus-4-6");
    expect(response.status).toBe(200);
    if (useStream)
      expect(await response.text()).toContain("event: message_start\n");
    else expect(await response.json()).toEqual({ token: a.id });
    expect(sent).toHaveLength(1);
    await evictDurableObject(a.stub);
    const view = await accountReply(
      a.stub.run({ action: "view" }),
      accountViewSchema,
    );
    expect(view.quota.claude_limits).toEqual([{ model: "opus", until }]);
    expect(
      (await infer(c, crypto.randomUUID(), "claude-opus-4-6")).status,
    ).toBe(429);
    expect(sent).toHaveLength(1);
    messageHeaders = {};
    stream = false;
    expect((await infer(c)).status).toBe(200);
    expect(
      (
        await infer(
          config([a], { allow_extra_usage: true }),
          crypto.randomUUID(),
          "claude-opus-4-6",
        )
      ).status,
    ).toBe(200);
  },
);

test("Partial refresh retains the old refresh token and account identity across eviction", async () => {
  tokenLifetime = 30;
  const a = await ready();
  partialRefresh = true;
  const command = {
    action: "resolve" as const,
    connection: { provider_id: "claude", credential_id: a.id },
    proxy_configuration: { proxy_groups: [] },
  };
  expect((await a.stub.run(command)).ok).toBe(true);
  await evictDurableObject(a.stub);
  expect((await a.stub.run(command)).ok).toBe(true);
  const view = await accountReply(
    a.stub.run({ action: "view" }),
    accountViewSchema,
  );
  expect(view.claude?.account_id).toBe(a.id);
  expect(view.claude?.organization_id).toBe("org");
});
