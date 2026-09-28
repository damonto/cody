import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runDurableObjectAlarm,
  evictDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { parseConfig } from "../../src/config/store.ts";
import {
  accountReply,
  accountViewSchema,
  sessionViewSchema,
} from "../../src/providers/oauth/schema.ts";
import { handleInference } from "../../src/gateway/http/proxy.ts";
const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const sent: string[] = [];
const usage = new Map<string, number>();
const reject = new Set<string>();
let unknown = false,
  generic = false,
  pending = false;
let identity = 0;
const jwt = (sub: string) =>
  `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub, iss: "https://auth.x.ai", email: `${sub}@example.test` }))}.signature`;
beforeAll(() => applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  usage.clear();
  reject.clear();
  unknown = false;
  generic = false;
  pending = false;
  await env.CODY_CONFIG_KV.delete("gateway-config");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const token =
        request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          device_authorization_endpoint: "https://auth.x.ai/device",
          token_endpoint: "https://auth.x.ai/token",
        });
      if (url.pathname === "/device") {
        identity++;
        return Response.json({
          device_code: `account${identity}`,
          user_code: "ABCD",
          verification_uri: "https://auth.x.ai/activate",
          expires_in: 1200,
          interval: 5,
        });
      }
      if (url.pathname === "/token") {
        if (pending)
          return Response.json(
            { error: "authorization_pending" },
            { status: 400 },
          );
        const form = new URLSearchParams(
          new TextDecoder().decode(await request.arrayBuffer()),
        );
        const sub = form.get("device_code") ?? form.get("refresh_token")!;
        return Response.json({
          access_token: sub,
          refresh_token: sub,
          id_token: jwt(sub),
          expires_in: 3600,
        });
      }
      if (url.pathname === "/v1/billing")
        return unknown
          ? new Response("unavailable", { status: 503 })
          : Response.json({
              credit_usage_percent: usage.get(token) ?? 10,
              current_period: {
                type: "weekly",
                end: new Date(Date.now() + 600000).toISOString(),
              },
              on_demand_cap: 100,
              on_demand_used: 1,
            });
      if (url.pathname === "/v1/responses") {
        sent.push(token);
        expect(request.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
        expect(request.headers.has("x-api-key")).toBe(false);
        if (generic)
          return Response.json(
            { code: "rate_limit", error: "slow down" },
            { status: 429 },
          );
        if (reject.has(token))
          return Response.json(
            {
              code: "subscription:free-usage-exhausted",
              error: "Limit for grok-4.7",
            },
            { status: 429, headers: { "retry-after": "600" } },
          );
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp", output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
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
      provider_type: "xai",
      flow: "device",
      connection: { provider_id: "xai", credential_id: id },
    }),
    sessionViewSchema,
  );
  expect(session.user_code).toBe("ABCD");
  expect(session.verification_uri).toBe("https://auth.x.ai/activate");
  for (let i = 0; i < 4; i++) {
    await runDurableObjectAlarm(stub);
    const view = await accountReply(
      stub.run({ action: "view" }),
      accountViewSchema,
    );
    if (view.status === "ready")
      return { ref, id, stub, sub: view.xai!.subject };
  }
  throw new Error("Authorization did not complete");
}
function config(accounts: { ref: string; id: string }[], extra = {}) {
  return parseConfig({
    providers: [
      {
        type: "xai",
        id: "xai",
        disabled: false,
        priority: 100,
        models: ["grok-4.7"],
        credentials: accounts.map((account) => ({
          id: account.id,
          auth: { type: "oauth", account_ref: account.ref },
          priority: 100,
          disabled: false,
        })),
        ...extra,
      },
    ],
    api_keys: [{ id: "client", api_key: "secret", providers: ["xai"] }],
  });
}
async function infer(
  c: ReturnType<typeof config>,
  session = crypto.randomUUID(),
) {
  const context = createExecutionContext();
  const response = await handleInference(
    new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "secret" },
      body: JSON.stringify({
        model: "grok-4.7",
        messages: [{ role: "user", content: "hello" }],
        metadata: { user_id: JSON.stringify({ session_id: session }) },
      }),
    }),
    env,
    c,
    c.api_keys[0],
    "messages",
    crypto.randomUUID(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
test("xAI device accounts and quota survive object eviction", async () => {
  const account = await ready();
  const quota = await accountReply(
    account.stub.run({ action: "quota", force: true }),
    accountViewSchema,
  );
  expect(quota.quota.groups[0].buckets[0].used_percent).toBe(10);
  await evictDurableObject(account.stub);
  const view = await accountReply(
    account.stub.run({ action: "view" }),
    accountViewSchema,
  );
  expect(view.xai?.subject).toBe(account.sub);
  expect(view.status).toBe("ready");
});
test("xAI switches only after persisting an explicit account model limit", async () => {
  const a = await ready(),
    b = await ready();
  reject.add(a.sub);
  const c = config([a, b], { account_selection: "session_affinity" });
  const response = await infer(c);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ content: [{ text: "OK" }] });
  expect(sent).toEqual([a.sub, b.sub]);
  await evictDurableObject(a.stub);
  const view = await accountReply(
    a.stub.run({ action: "view" }),
    accountViewSchema,
  );
  expect(view.quota.xai_limits?.[0].model).toBe("grok-4.7");
});
test("xAI generic 429 does not switch accounts", async () => {
  const a = await ready(),
    b = await ready();
  generic = true;
  const response = await infer(config([a, b]));
  expect(response.status).toBe(429);
  await response.text();
  expect(sent).toHaveLength(1);
});
test("xAI subscription precedes paid use and unknown quota fails closed", async () => {
  const a = await ready(),
    b = await ready();
  usage.set(a.sub, 100);
  const response = await infer(
    config([a, b], {
      account_selection: "session_affinity",
      allow_extra_usage: true,
    }),
  );
  await response.text();
  expect(sent).toEqual([b.sub]);
  sent.length = 0;
  unknown = true;
  const fresh = await ready();
  const refused = await infer(config([fresh]));
  expect(refused.status).toBe(503);
  await refused.text();
  expect(sent).toHaveLength(0);
});
test("xAI extra usage needs explicit opt-in", async () => {
  const a = await ready();
  usage.set(a.sub, 100);
  const blocked = await infer(config([a]));
  expect(blocked.status).toBe(429);
  await blocked.text();
  expect(sent).toHaveLength(0);
  const allowed = await infer(config([a], { allow_extra_usage: true }));
  expect(allowed.status).toBe(200);
  await allowed.text();
  expect(sent).toEqual([a.sub]);
});
test("xAI quota observations are fenced across disconnect", async () => {
  const a = await ready();
  const before = await accountReply(
    a.stub.run({ action: "view" }),
    accountViewSchema,
  );
  await a.stub.run({ action: "disconnect" });
  const result = await a.stub.run({
    action: "xai_limit",
    generation: before.generation!,
    model: null,
    kind: "subscription",
    until: Date.now() + 10000,
  });
  expect(result.ok).toBe(false);
  const after = await accountReply(
    a.stub.run({ action: "view" }),
    accountViewSchema,
  );
  expect(after.status).toBe("disconnected");
});
test("cancelled xAI devices cannot initialize", async () => {
  pending = true;
  const ref = crypto.randomUUID();
  const stub = env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
  const session = await accountReply(
    stub.run({
      action: "start",
      account_ref: ref,
      actor: "admin",
      provider_type: "xai",
      flow: "device",
      connection: { provider_id: "xai", credential_id: "a" },
    }),
    sessionViewSchema,
  );
  await runDurableObjectAlarm(stub);
  await stub.run({
    action: "cancel",
    actor: "admin",
    session_id: session.id.split(".")[1],
  });
  pending = false;
  await runDurableObjectAlarm(stub);
  const view = await accountReply(
    stub.run({ action: "view" }),
    accountViewSchema,
  );
  expect(view.status).toBe("disconnected");
});
