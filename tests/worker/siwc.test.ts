import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  accountReply,
  accountViewSchema,
  resolvedOAuthSchema,
  sessionViewSchema,
  type SessionView,
} from "../../src/providers/oauth/schema.ts";
import {
  SIWC_SCOPE,
  SIWC_REDIRECT_URI,
} from "../../src/providers/codex/siwc.ts";
import { gatewayApp } from "../../src/gateway/app.ts";
import {
  clearConfigCacheForTests,
  parseConfig,
} from "../../src/config/store.ts";
import { setTestConfiguration } from "../helpers/worker-configuration.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const issuer = "https://auth.openai.com";
const actor = "admin@example.test";
const scopes = new Map<string, string>();
const nonces = new Map<string, string>();
const requests: { url: string; body: string }[] = [];
const connections = new Map<string, string>();
const upgrades: string[] = [];
const exhaustedTokens = new Set<string>();
const testUpstream = () => Reflect.get(env, "TEST_UPSTREAM") as Fetcher;
const control = (connection: string, path: string) =>
  `https://test-upstream${path}?connection_id=${connection}`;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let rejectModels = 0;
let failRefresh = false;
let failRevoke = false;
let holdExchange: Promise<void> | undefined;
let exchangeStarted: (() => void) | undefined;

beforeAll(async () => {
  await applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS);
  pair = await generateKeyPair("RS256");
});
beforeEach(() => {
  clearConfigCacheForTests();
  connections.clear();
  upgrades.length = 0;
  exhaustedTokens.clear();
  requests.length = 0;
  nonces.clear();
  scopes.clear();
  rejectModels = 0;
  failRefresh = false;
  failRevoke = false;
  holdExchange = undefined;
  exchangeStarted = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const body = request.body
        ? new TextDecoder().decode(await request.clone().arrayBuffer())
        : "";
      requests.push({ url: request.url, body });
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          token_endpoint: `${issuer}/api/accounts/oauth/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
        });
      if (url.pathname === "/.well-known/jwks.json")
        return Response.json({
          keys: [
            { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" },
          ],
        });
      if (url.pathname.endsWith("/oauth/token")) {
        const form = new URLSearchParams(body);
        const refresh = form.get("grant_type") === "refresh_token";
        if (refresh && failRefresh)
          return Response.json(
            { error: "refresh_token_reused" },
            { status: 400 },
          );
        const code = form.get("code") ?? "refreshed";
        if (!refresh) {
          exchangeStarted?.();
          await holdExchange;
        }
        const idToken = await new SignJWT({
          nonce: nonces.get(code),
          email: "operator@example.test",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer(issuer)
          .setAudience(form.get("client_id")!)
          .setSubject("subject")
          .setExpirationTime("1h")
          .sign(pair.privateKey);
        return Response.json({
          access_token: `access-${code}`,
          refresh_token: `refresh-${code}`,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: scopes.get(code) ?? SIWC_SCOPE,
        });
      }
      if (url.pathname.endsWith("/oauth/revoke"))
        return new Response(null, { status: failRevoke ? 503 : 200 });
      if (url.href === "https://api.openai.com/v1/responses") {
        const token = request.headers.get("authorization")!;
        upgrades.push(token);
        if (exhaustedTokens.has(token))
          return Response.json(
            {
              error: {
                code: "subscription_sharing_usage_limit_exceeded",
                message: "original limit",
              },
            },
            { status: 429 },
          );
        const id = crypto.randomUUID();
        connections.set(token, id);
        return testUpstream().fetch(
          new Request(control(id, "/responses"), {
            headers: { upgrade: "websocket" },
          }),
        );
      }
      if (url.href === "https://api.openai.com/v1/models") {
        if (rejectModels > 0) {
          rejectModels--;
          return new Response("expired upstream authorization", {
            status: 401,
          });
        }
        return Response.json({
          models: [
            { slug: "gpt-test", visibility: "list" },
            { slug: "hidden", visibility: "hidden" },
          ],
        });
      }
      throw new Error(`Unexpected SIWC request: ${request.url}`);
    }),
  );
});
afterEach(async () => {
  for (const id of connections.values())
    await testUpstream().fetch(
      new Request(control(id, "/__test/close"), { method: "POST" }),
    );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(ref = crypto.randomUUID()) {
  const stub = env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
  const connection = {
    provider_id: "codex",
    credential_id: `credential-${ref}`,
  };
  const session = await accountReply(
    stub.run({
      action: "start",
      account_ref: ref,
      actor,
      connection,
      provider_type: "codex",
      flow: "siwc",
    }),
    sessionViewSchema,
  );
  return { stub, ref, connection, session };
}
function callback(session: SessionView, code: string, issued = true) {
  const url = new URL(session.url!);
  nonces.set(code, url.searchParams.get("nonce")!);
  return `${SIWC_REDIRECT_URI}?${new URLSearchParams({ state: url.searchParams.get("state")!, code, ...(issued ? { client_id: "oaiapp_test" } : {}) })}`;
}
async function finish(f: Awaited<ReturnType<typeof start>>, code: string) {
  await accountReply(
    f.stub.run({
      action: "complete",
      session_id: f.session.id.split(".")[1]!,
      actor,
      redirect_url: callback(f.session, code),
    }),
    sessionViewSchema,
  );
  await expect
    .poll(async () => {
      await runDurableObjectAlarm(f.stub);
      return (
        await accountReply(f.stub.run({ action: "view" }), accountViewSchema)
      ).status;
    })
    .toBe("ready");
  return accountReply(f.stub.run({ action: "view" }), accountViewSchema);
}
async function configure(
  f: Awaited<ReturnType<typeof start>>,
  others: Awaited<ReturnType<typeof start>>[] = [],
) {
  const config = parseConfig({
    providers: [
      {
        id: "codex",
        type: "codex",
        disabled: false,
        priority: 100,
        account_selection: "session_affinity",
        models: ["gpt-test"],
        credentials: [f, ...others].map((entry) => ({
          id: entry.connection.credential_id,
          priority: 100,
          disabled: false,
          auth: { type: "oauth", account_ref: entry.ref },
        })),
      },
    ],
    api_keys: [{ id: "client", api_key: "siwc-client", providers: ["codex"] }],
  });
  await setTestConfiguration(
    env.CODY_DB,
    env.CONFIG_ENCRYPTION_KEY,
    JSON.stringify(config),
  );
  await env.CODY_CONFIG_KV.delete("gateway-config");
}

test("SIWC persists a validated registration, reuses it after eviction and keeps host ID shared", async () => {
  const f = await start();
  const other = await start();
  expect(new URL(f.session.url!).searchParams.get("ext_agent_host_id")).toBe(
    new URL(other.session.url!).searchParams.get("ext_agent_host_id"),
  );
  const view = await finish(f, "first");
  expect(view.codex?.mode).toBe("siwc");
  expect(view.codex?.account_id).toBeNull();
  expect(JSON.stringify(view)).not.toContain("access-first");
  expect(await f.stub.run({ action: "readiness" })).toMatchObject({
    ok: true,
    data: { ready: true, codex_mode: "siwc" },
  });
  await evictDurableObject(f.stub);
  const again = await start(f.ref);
  expect(new URL(again.session.url!).searchParams.get("client_id")).toBe(
    "oaiapp_test",
  );
  expect(new URL(again.session.url!).searchParams.has("agent_name_hint")).toBe(
    false,
  );
  expect(
    await f.stub.run({
      action: "start",
      account_ref: f.ref,
      actor,
      connection: f.connection,
      provider_type: "codex",
      flow: "device",
    }),
  ).toMatchObject({ ok: false, status: 409 });
});

test("SIWC validates callback state and one-time consumption without invalidating active credentials", async () => {
  const f = await start();
  expect(
    await f.stub.run({
      action: "complete",
      session_id: f.session.id.split(".")[1]!,
      actor,
      redirect_url: callback(f.session, "bad") + "&state=duplicate",
    }),
  ).toMatchObject({ ok: false, status: 400 });
  await finish(f, "good");
  expect(
    await f.stub.run({
      action: "complete",
      session_id: f.session.id.split(".")[1]!,
      actor,
      redirect_url: callback(f.session, "good"),
    }),
  ).toMatchObject({ ok: false, status: 409 });
});

test("declined plan permission retains sign-in and excludes inference readiness", async () => {
  const f = await start();
  scopes.set("identity", "openid profile email offline_access");
  const view = await finish(f, "identity");
  expect(view.codex?.plan_usage_enabled).toBe(false);
  expect(await f.stub.run({ action: "readiness" })).toMatchObject({
    ok: true,
    data: { ready: false },
  });
});

test("a cancelled code exchange cannot commit late SIWC credentials", async () => {
  const f = await start();
  let startedExchange = false;
  let resolveRelease!: () => void;
  const release = {
    promise: new Promise<void>((resolve) => {
      resolveRelease = resolve;
    }),
    resolve: () => resolveRelease(),
  };
  exchangeStarted = () => {
    startedExchange = true;
  };
  holdExchange = release.promise;
  const completing = f.stub.run({
    action: "complete",
    session_id: f.session.id.split(".")[1]!,
    actor,
    redirect_url: callback(f.session, "late"),
  });
  await expect.poll(() => startedExchange).toBe(true);
  await f.stub.run({
    action: "cancel",
    session_id: f.session.id.split(".")[1]!,
    actor,
  });
  release.resolve();
  await completing;
  expect(await f.stub.run({ action: "readiness" })).toMatchObject({
    ok: true,
    data: { ready: false },
  });
  expect(
    (await accountReply(f.stub.run({ action: "view" }), accountViewSchema))
      .codex,
  ).toBeNull();
});

test("SIWC model inventory and recovery use the public token partition only", async () => {
  const f = await start();
  await finish(f, "inventory");
  await configure(f);
  const view = await accountReply(
    f.stub.run({ action: "models" }),
    accountViewSchema,
  );
  expect(view.models.map((model) => model.id)).toEqual(["gpt-test"]);
  const generation = view.generation!;
  const recover = () =>
    accountReply(
      f.stub.run({
        action: "codex_refresh",
        generation,
        token: "access-inventory",
        connection: f.connection,
        proxy_configuration: { proxy_groups: [] },
      }),
      resolvedOAuthSchema,
    );
  const [recovered, concurrent] = await Promise.all([recover(), recover()]);
  expect(recovered.token).toBe("access-refreshed");
  expect(concurrent.token).toBe(recovered.token);
  expect(
    requests.filter(
      (request) =>
        request.url.endsWith("/oauth/token") &&
        new URLSearchParams(request.body).get("grant_type") === "refresh_token",
    ),
  ).toHaveLength(1);
  const refreshes = requests.filter(
    (request) => request.url === `${issuer}/api/accounts/oauth/token`,
  );
  expect(new URLSearchParams(refreshes.at(-1)!.body).get("client_id")).toBe(
    "oaiapp_test",
  );
  expect(await f.stub.run({ action: "reset_credits" })).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(requests.some((request) => request.url.includes("backend-api"))).toBe(
    false,
  );
  failRefresh = true;
  expect(
    await f.stub.run({
      action: "codex_refresh",
      generation,
      token: "access-refreshed",
      connection: f.connection,
      proxy_configuration: { proxy_groups: [] },
    }),
  ).toMatchObject({ ok: false, code: "invalid_grant" });
  const again = await start(f.ref);
  expect(new URL(again.session.url!).searchParams.get("client_id")).toBe(
    "oaiapp_test",
  );
});

test("SIWC disconnect clears tokens and reports unconfirmed remote revocation", async () => {
  const f = await start();
  await finish(f, "disconnect");
  await configure(f);
  failRevoke = true;
  const view = await accountReply(
    f.stub.run({ action: "disconnect" }),
    accountViewSchema,
  );
  expect(view.status).toBe("disconnected");
  expect(view.error).toContain("remote revocation was not confirmed");
  expect(await f.stub.run({ action: "readiness" })).toMatchObject({
    ok: true,
    data: { ready: false },
  });
  expect(
    new URL((await start(f.ref)).session.url!).searchParams.get("client_id"),
  ).toBe("oaiapp_test");
});

async function openSocket() {
  const response = await gatewayApp.fetch(
    new Request("https://gateway.test/v1/responses", {
      headers: {
        authorization: "Bearer siwc-client",
        connection: "Upgrade",
        upgrade: "websocket",
      },
    }),
    env,
    createExecutionContext(),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const messages: string[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
  });
  const close = new Promise<CloseEvent>((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  return { socket, messages, close };
}
const frame = JSON.stringify({
  type: "response.create",
  model: "gpt-test",
  store: false,
  input: [{ role: "user", content: "hello" }],
});
async function upstreamMessages(connection: string) {
  const response = await testUpstream().fetch(
    new Request(control(connection, "/__test/messages")),
  );
  const { messages } = await response.json<{ messages: { data: string }[] }>();
  return messages.map((message) => message.data);
}

test("SIWC WebSockets preserve valid frames and validate every later response.create", async () => {
  const f = await start();
  await finish(f, "websocket");
  await configure(f);
  const client = await openSocket();
  client.socket.send(frame);
  const received: string[] = [];
  await expect
    .poll(async () => {
      const connection = connections.get("Bearer access-websocket");
      if (connection) received.push(...(await upstreamMessages(connection)));
      return received.length;
    })
    .toBe(1);
  expect(received[0]).toBe(frame);
  const connection = connections.get("Bearer access-websocket")!;
  await testUpstream().fetch(
    new Request(control(connection, "/__test/send"), {
      method: "POST",
      body: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_first", status: "completed", output: [] },
      }),
    }),
  );
  await expect.poll(() => client.messages.length).toBe(1);
  client.socket.send(JSON.stringify({ ...JSON.parse(frame), stream: true }));
  await expect
    .poll(() =>
      client.messages.some(
        (message) => JSON.parse(message).error?.param === "stream",
      ),
    )
    .toBe(true);
  expect((await client.close).code).toBe(1008);
  expect(await upstreamMessages(connection)).toEqual([]);
});

test("SIWC WebSocket handshake quota switching stays in SIWC and output blocks later replay", async () => {
  const first = await start();
  const second = await start();
  await finish(first, "limited-ws");
  await finish(second, "available-ws");
  await configure(first, [second]);
  exhaustedTokens.add("Bearer access-limited-ws");
  const client = await openSocket();
  client.socket.send(frame);
  await expect.poll(() => upgrades.length).toBe(2);
  expect(upgrades).toEqual([
    "Bearer access-limited-ws",
    "Bearer access-available-ws",
  ]);
  const received: string[] = [];
  await expect
    .poll(async () => {
      const id = connections.get("Bearer access-available-ws");
      if (id) received.push(...(await upstreamMessages(id)));
      return received.length;
    })
    .toBe(1);
  const id = connections.get("Bearer access-available-ws")!;
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    delta: "visible",
  });
  const failed = JSON.stringify({
    type: "response.failed",
    response: {
      id: "resp_failed",
      status: "failed",
      error: { code: "subscription_sharing_usage_limit_exceeded" },
    },
  });
  for (const body of [delta, failed])
    await testUpstream().fetch(
      new Request(control(id, "/__test/send"), { method: "POST", body }),
    );
  await expect.poll(() => client.messages.length).toBe(2);
  expect(client.messages).toEqual([delta, failed]);
  await client.close;
  expect(upgrades).toHaveLength(2);
});

test.each([1, 2])(
  "SIWC model reads recover non-JSON 401 only once (%i rejections)",
  async (rejections) => {
    const f = await start();
    await finish(f, "model-auth");
    await configure(f);
    rejectModels = rejections;
    const view = await accountReply(
      f.stub.run({ action: "models" }),
      accountViewSchema,
    );
    expect(
      requests.filter(
        (request) => request.url === "https://api.openai.com/v1/models",
      ),
    ).toHaveLength(2);
    expect(
      requests.filter(
        (request) =>
          request.url.endsWith("/oauth/token") &&
          new URLSearchParams(request.body).get("grant_type") ===
            "refresh_token",
      ),
    ).toHaveLength(1);
    if (rejections === 1)
      expect(view.models.map((model) => model.id)).toEqual(["gpt-test"]);
    else expect(view.models_error).toContain("401");
  },
);
