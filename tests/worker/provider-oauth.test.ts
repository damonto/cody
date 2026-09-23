import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";
import { z } from "zod";
import { app } from "../../src/worker.ts";
import { parseConfig } from "../../src/config/store.ts";
import type {
  AiGatewayProviderConfig,
  AntigravityProviderConfig,
  CredentialAuth,
} from "../../src/config/types.ts";
import type {
  CredentialResolver,
  ResolvedApiKey,
  ResolvedOAuth,
  ResolvedCredential,
} from "../../src/providers/credentials.ts";
import type { ProviderAdapter } from "../../src/providers/types.ts";
import { decryptConfig, encryptConfig } from "../../src/control/crypto.ts";
import { ControlStore } from "../../src/control/store.ts";
import { draftViewSchema } from "../../src/control/schema.ts";
import {
  accountReply,
  accountViewSchema,
  sessionViewSchema,
  resolvedOAuthSchema,
  tokenSchema,
  type ProviderConnection,
  type SessionView,
} from "../../src/providers/oauth/schema.ts";
import { handleInference } from "../../src/gateway/http/proxy.ts";
import {
  handleModels,
  clearModelsCacheForTests,
} from "../../src/gateway/catalog/models.ts";
import { socksFetch } from "../../src/gateway/transport/socks-fetch.ts";
import { SocksProxyError } from "../../src/gateway/proxies/errors.ts";
import { proxyGroupSnapshot } from "../../src/gateway/proxies/configuration.ts";

vi.mock(
  import("../../src/gateway/transport/socks-fetch.ts"),
  async (original) => ({
    ...(await original()),
    socksFetch: vi.fn<typeof socksFetch>(),
  }),
);
type Account = ReturnType<Env["PROVIDER_OAUTH_ACCOUNT"]["getByName"]>;
const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const actor = "admin@example.test";
const control = () =>
  new ControlStore(env.CODY_DB, env.CODY_CONFIG_KV, env.CONFIG_ENCRYPTION_KEY);
const records: {
  url: string;
  body: string;
  authorization: string | null;
  proxy: string | null;
}[] = [];
let override:
  | ((
      request: Request,
      body: string,
    ) => Response | undefined | Promise<Response | undefined>)
  | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(() => applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  records.length = 0;
  override = undefined;
  clearModelsCacheForTests();
  await env.CODY_DB.batch(
    [
      "DELETE FROM oauth_accounts",
      "DELETE FROM oauth_clients",
      "DELETE FROM audit_log",
      "DELETE FROM config_revisions",
      "UPDATE control_state SET draft_version = 0, draft_payload = NULL, published_revision = NULL, updated_at = 0 WHERE id = 1",
    ].map((sql) => env.CODY_DB.prepare(sql)),
  );
  await env.CODY_CONFIG_KV.delete("gateway-config");
  await Promise.all(
    ["antigravity", "key:antigravity:primary", "key:antigravity:one"].flatMap(
      (id) =>
        [id, `${id}:catalog`].map((name) => env.HEALTH.getByName(name).clear()),
    ),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((request: Request) => send(request)),
  );
  vi.mocked(socksFetch).mockImplementation((request, proxy) =>
    send(request, proxy.url),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function send(
  request: Request,
  proxy: string | null = null,
): Promise<Response> {
  const body = request.body
    ? new TextDecoder().decode(await request.clone().arrayBuffer())
    : "";
  records.push({
    url: request.url,
    body,
    authorization: request.headers.get("authorization"),
    proxy,
  });
  const response = await override?.(request, body);
  if (response) return response;
  if (request.url.includes("oauth2.googleapis.com/token")) {
    const fields = new URLSearchParams(body);
    return Response.json({
      access_token:
        fields.get("grant_type") === "refresh_token"
          ? "refreshed-access"
          : `access-${fields.get("code")}`,
      refresh_token: "refresh-token",
      expires_in: 3600,
    });
  }
  if (request.url.includes("/userinfo"))
    return Response.json({ id: "google-user", email: "user@example.test" });
  if (request.url.includes(":loadCodeAssist"))
    return Response.json({
      cloudaicompanionProject: "project",
      currentTier: { id: "free-tier", name: "Free" },
    });
  if (request.url.includes(":onboardUser"))
    return Response.json({
      done: true,
      response: { cloudaicompanionProject: { id: "project" } },
    });
  if (request.url.includes(":fetchAvailableModels"))
    return Response.json({
      models: {
        "native-model": {
          displayName: "Native",
          inputTokenLimit: 1000000,
          outputTokenLimit: 64000,
          quotaInfo: { remainingFraction: 0.5 },
        },
        hidden: { displayName: "Hidden" },
      },
    });
  if (request.url.includes(":retrieveUserQuotaSummary"))
    return Response.json({
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            {
              window: "weekly",
              remainingFraction: 0.75,
              resetTime: "2026-10-01T00:00:00Z",
            },
          ],
        },
      ],
    });
  if (request.url.includes(":countTokens"))
    return Response.json({ totalTokens: 12 });
  if (/:(?:streamG|g)enerateContent/.test(request.url)) {
    const response = {
      response: {
        candidates: [
          { content: { parts: [{ text: "hello" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      },
    };
    return request.url.includes("streamGenerateContent")
      ? new Response(`data: ${JSON.stringify(response)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(response);
  }
  throw new Error(`Unexpected test request: ${request.url}`);
}
async function start(
  connection: ProviderConnection = {
    provider_id: "antigravity",
    credential_id: "primary",
  },
  ref = crypto.randomUUID(),
) {
  const stub = env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
  const session = await accountReply(
    stub.run({ action: "start", actor, account_ref: ref, connection }),
    sessionViewSchema,
  );
  return { stub, session, connection, ref };
}
function callback(session: SessionView, code = "initial") {
  const state = new URL(session.url!).searchParams.get("state")!;
  return `http://localhost:51121/oauth-callback?${new URLSearchParams({ state, code })}`;
}
function sessionId(session: SessionView) {
  return session.id.split(".")[1];
}
async function complete(stub: Account, session: SessionView, code = "initial") {
  return accountReply(
    stub.run({
      action: "complete",
      actor,
      session_id: sessionId(session),
      redirect_url: callback(session, code),
    }),
    sessionViewSchema,
  );
}
async function initialize(stub: Account) {
  for (let i = 0; i < 7; i++) {
    await runDurableObjectAlarm(stub);
    const view = await accountReply(
      stub.run({ action: "view" }),
      accountViewSchema,
    );
    if (view.status === "ready") return view;
  }
  throw new Error("Account did not become ready");
}
// Account alarms are due immediately, so workerd may fire them on its own
// before the test does; drive them until the session leaves "initializing".
async function settleSession(stub: Account, session: SessionView) {
  for (let i = 0; i < 7; i++) {
    await runDurableObjectAlarm(stub);
    const view = await accountReply(
      stub.run({ action: "session", actor, session_id: sessionId(session) }),
      sessionViewSchema,
    );
    if (view.status !== "initializing") return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Session did not leave initialization");
}
async function ready(connection?: ProviderConnection, ref?: string) {
  const account = await start(connection, ref);
  await complete(account.stub, account.session);
  await initialize(account.stub);
  return account;
}
const storedObject = z.record(z.string(), z.unknown());
async function storage(stub: Account) {
  return runInDurableObject(stub, async (_instance, state) =>
    storedObject.parse(
      await decryptConfig(
        (await state.storage.get<string>("account"))!,
        env.CONFIG_ENCRYPTION_KEY,
      ),
    ),
  );
}
async function rewrite(
  stub: Account,
  update: (value: Record<string, unknown>) => void,
) {
  await runInDurableObject(stub, async (_instance, state) => {
    const value = storedObject.parse(
      await decryptConfig(
        (await state.storage.get<string>("account"))!,
        env.CONFIG_ENCRYPTION_KEY,
      ),
    );
    update(value);
    await state.storage.put(
      "account",
      await encryptConfig(value, env.CONFIG_ENCRYPTION_KEY),
    );
  });
  await evictDurableObject(stub);
}
async function expireToken(stub: Account) {
  await rewrite(stub, (value) => {
    value.tokens = {
      ...tokenSchema.parse(value.tokens),
      expires_at: Date.now() + 120_000,
    };
  });
}
const resolve = (
  stub: Account,
  connection: ProviderConnection,
  proxy_groups: ReturnType<typeof parseConfig>["proxy_groups"] = [],
) =>
  accountReply(
    stub.run({
      action: "resolve",
      connection,
      proxy_configuration: { proxy_groups },
    }),
    resolvedOAuthSchema,
  );
const tokenRequests = () =>
  records.filter((record) =>
    record.url.includes("oauth2.googleapis.com/token"),
  );

test("adapter and resolver credential types preserve their authentication discriminants", () => {
  expectTypeOf<
    Parameters<ProviderAdapter<AiGatewayProviderConfig>["prepare"]>[1]
  >().toEqualTypeOf<ResolvedApiKey>();
  expectTypeOf<
    Parameters<ProviderAdapter<AntigravityProviderConfig>["prepare"]>[1]
  >().toEqualTypeOf<ResolvedOAuth>();
  expectTypeOf<
    Parameters<ProviderAdapter["prepare"]>[1]
  >().toEqualTypeOf<ResolvedCredential>();
  expectTypeOf<
    Awaited<ReturnType<CredentialResolver<CredentialAuth>["resolve"]>>
  >().toEqualTypeOf<ResolvedCredential>();
});

test("OAuth commands reject missing and unrelated fields before changing account state", async () => {
  const { stub } = await ready();
  const before = await storage(stub);
  const invalid: unknown[] = [
    { action: "start" },
    { action: "session", session_id: crypto.randomUUID() },
    { action: "complete", session_id: crypto.randomUUID(), actor },
    {
      action: "resolve",
      connection: { provider_id: "google", credential_id: "one" },
    },
    { action: "view", redirect_url: "must-not-be-accepted" },
    { action: "disconnect", force: true },
    { action: "quota", force: "true" },
  ];
  for (const command of invalid) {
    // @ts-expect-error Deliberately bypass the typed RPC contract to test runtime validation.
    const reply = await stub.run(command);
    expect(reply).toMatchObject({ ok: false, status: 400 });
  }
  expect(await storage(stub)).toEqual(before);
});

test("authorization uses random state, S256 PKCE and only encrypted credential storage", async () => {
  const account = await start();
  const url = new URL(account.session.url!);
  const persisted = storedObject.parse((await storage(account.stub)).session);
  expect(persisted.verifier).not.toBe(url.searchParams.get("code_challenge"));
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(z.string().parse(persisted.verifier)),
    ),
  );
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(url.searchParams.get("code_challenge")).toBe(challenge);
  expect(account.session.expires_at - Date.now()).toBeGreaterThan(590_000);
  await complete(account.stub, account.session);
  const view = await initialize(account.stub);
  expect(view).toMatchObject({
    email: "user@example.test",
    project_id: "project",
    status: "ready",
  });
  expect(JSON.stringify(view)).not.toContain("access-initial");
  expect(JSON.stringify(view)).not.toContain("refresh-token");
  const encrypted = await runInDurableObject(account.stub, (_instance, state) =>
    state.storage.get<string>("account"),
  );
  expect(encrypted).not.toContain("refresh-token");
  const rows = await env.CODY_DB.prepare("SELECT * FROM oauth_accounts").all();
  expect(JSON.stringify(rows.results)).not.toMatch(
    /token|verifier|google-user/,
  );
  expect(
    new URLSearchParams(tokenRequests()[0].body).get("code_verifier"),
  ).toBe(persisted.verifier);
  await evictDurableObject(account.stub);
  expect(await resolve(account.stub, account.connection)).toEqual({
    token: "access-initial",
    project_id: "project",
  });
});

test("desktop OAuth authorizes and refreshes without a configured client registration", async () => {
  const { stub, connection, session } = await ready();
  expect(JSON.stringify(session)).not.toContain("GOCSPX-");
  await expireToken(stub);
  expect(await resolve(stub, connection)).toEqual({
    token: "refreshed-access",
    project_id: "project",
  });
  const tokens = tokenRequests().map((request) =>
    Object.fromEntries(new URLSearchParams(request.body)),
  );
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toMatchObject({
    grant_type: "authorization_code",
    client_id: new URL(session.url!).searchParams.get("client_id"),
    client_secret: expect.stringMatching(/^GOCSPX-/),
  });
  expect(tokens[1]).toMatchObject({
    grant_type: "refresh_token",
    client_id: tokens[0].client_id,
    client_secret: tokens[0].client_secret,
    refresh_token: "refresh-token",
  });
  expect(
    await env.CODY_DB.prepare("SELECT 1 FROM oauth_clients").first(),
  ).toBeNull();
});

test("forged callbacks, wrong admins and duplicate submissions cannot exchange a code", async () => {
  const { stub, session } = await start();
  const valid = callback(session);
  for (const url of [
    valid.replace("localhost", "127.0.0.1"),
    valid.replace("http:", "https:"),
    valid.replace("51121", "8080"),
    valid.replace("oauth-callback", "other"),
    `${valid}&state=other`,
    valid.replace(/state=[^&]+/, "state=forged"),
    `${valid}&code=extra`,
    `${valid}#fragment`,
    valid.replace("localhost", "user@localhost"),
  ]) {
    expect(
      await stub.run({
        action: "complete",
        actor,
        session_id: sessionId(session),
        redirect_url: url,
      }),
    ).toMatchObject({ ok: false, status: 400 });
  }
  expect(
    await stub.run({
      action: "complete",
      actor: "other-admin",
      session_id: sessionId(session),
      redirect_url: valid,
    }),
  ).toMatchObject({ ok: false, status: 403 });
  expect(tokenRequests()).toHaveLength(0);
  await complete(stub, session);
  expect(
    await stub.run({
      action: "complete",
      actor,
      session_id: sessionId(session),
      redirect_url: valid,
    }),
  ).toMatchObject({ ok: false, status: 409 });
  expect(tokenRequests()).toHaveLength(1);
  await initialize(stub);
});

test("cancelled and expired sessions cannot be completed after eviction", async () => {
  for (const action of ["cancel", "expire"]) {
    const { stub, session } = await start();
    if (action === "cancel") {
      await stub.run({
        action: "cancel",
        actor,
        session_id: sessionId(session),
      });
      await evictDurableObject(stub);
    } else
      await rewrite(stub, (value) => {
        value.session = {
          ...storedObject.parse(value.session),
          expires_at: Date.now() - 1,
        };
      });
    expect(
      await stub.run({
        action: "complete",
        actor,
        session_id: sessionId(session),
        redirect_url: callback(session),
      }),
    ).toMatchObject({ ok: false, status: 410 });
    const stored = storedObject.parse((await storage(stub)).session);
    expect(stored.verifier).toBe("");
    expect(stored.tokens).toBeNull();
  }
  expect(tokenRequests()).toHaveLength(0);
});

test("initialization failure retains tokens across eviction and retries without a second exchange", async () => {
  override = (request) =>
    request.url.includes(":loadCodeAssist")
      ? new Response("temporary error", { status: 503 })
      : undefined;
  const { stub, session } = await start();
  await complete(stub, session);
  const progress = await settleSession(stub, session);
  expect(progress).toMatchObject({ status: "error", can_retry: true });
  await evictDurableObject(stub);
  override = undefined;
  await stub.run({ action: "retry", actor, session_id: sessionId(session) });
  await initialize(stub);
  expect(tokenRequests()).toHaveLength(1);
  expect(
    records.filter((record) => record.url.includes("/userinfo")),
  ).toHaveLength(1);
});

test("concurrent refreshes are merged and refresh-token rotation or omission is persisted", async () => {
  const { stub, connection } = await ready();
  await expireToken(stub);
  const gate = deferred<void>();
  override = async (request, body) => {
    if (
      !request.url.includes("/token") ||
      new URLSearchParams(body).get("grant_type") !== "refresh_token"
    )
      return;
    await gate.promise;
    return Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
  };
  const both = Promise.all([
    resolve(stub, connection),
    resolve(stub, connection),
  ]);
  await vi.waitFor(() => expect(tokenRequests()).toHaveLength(2));
  gate.resolve();
  const [first, second] = await both;
  expect(first).toMatchObject({ token: "rotated-access" });
  expect(second).toMatchObject({ token: "rotated-access" });
  expect(tokenSchema.parse((await storage(stub)).tokens).refresh_token).toBe(
    "rotated-refresh",
  );
  await expireToken(stub);
  override = (request) =>
    request.url.includes("/token")
      ? Response.json({ access_token: "no-rotation", expires_in: 3600 })
      : undefined;
  await resolve(stub, connection);
  expect(
    new URLSearchParams(tokenRequests().at(-1)!.body).get("refresh_token"),
  ).toBe("rotated-refresh");
  expect(tokenSchema.parse((await storage(stub)).tokens).refresh_token).toBe(
    "rotated-refresh",
  );
});

test("invalid_grant requires reauthorization without changing inference health", async () => {
  const { stub, connection } = await ready();
  await expireToken(stub);
  override = (request) =>
    request.url.includes("/token")
      ? Response.json(
          { error: "invalid_grant", error_description: "private error" },
          { status: 400 },
        )
      : undefined;
  await expect(resolve(stub, connection)).rejects.toThrow("reconnect");
  expect(
    await accountReply(stub.run({ action: "view" }), accountViewSchema),
  ).toMatchObject({ status: "needs_reauthorization" });
  expect(
    (await env.HEALTH.getByName(connection.provider_id).getStatus()).failures,
  ).toBe(0);
});

test("a late refresh cannot overwrite reauthorization of the same account", async () => {
  const { stub, connection, ref } = await ready();
  await expireToken(stub);
  const gate = deferred<void>();
  override = async (request, body) => {
    if (
      !request.url.includes("/token") ||
      new URLSearchParams(body).get("grant_type") !== "refresh_token"
    )
      return;
    await gate.promise;
    return Response.json({ access_token: "stale-refresh", expires_in: 3600 });
  };
  const oldRefresh = resolve(stub, connection).catch((error: unknown) => error);
  await vi.waitFor(() => expect(tokenRequests()).toHaveLength(2));
  const next = await start(connection, ref);
  await complete(stub, next.session, "reauthorized");
  // Reauthorization keeps active tokens usable until its new project is ready.
  for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
  gate.resolve();
  await oldRefresh;
  expect(await resolve(stub, connection)).toMatchObject({
    token: "access-reauthorized",
  });
  expect(tokenSchema.parse((await storage(stub)).tokens).access_token).toBe(
    "access-reauthorized",
  );
});

test("reauthorized tokens do not join a refresh from an older generation", async () => {
  const { stub, connection, ref } = await ready();
  await expireToken(stub);
  const gate = deferred<void>();
  override = async (request, body) => {
    if (!request.url.includes("/token")) return;
    const fields = new URLSearchParams(body);
    if (fields.get("grant_type") === "authorization_code")
      return Response.json({
        access_token: "reauthorized-short-lived",
        refresh_token: "new-refresh-token",
        expires_in: 120,
      });
    if (fields.get("refresh_token") === "refresh-token") {
      await gate.promise;
      return Response.json({ access_token: "old-refresh", expires_in: 3600 });
    }
    return Response.json({ access_token: "new-refresh", expires_in: 3600 });
  };
  const oldRefresh = resolve(stub, connection).catch((error: unknown) => error);
  await vi.waitFor(() => expect(tokenRequests()).toHaveLength(2));
  const next = await start(connection, ref);
  await complete(stub, next.session, "reauthorized");
  for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
  const newRefresh = resolve(stub, connection);
  // Observe the new request before releasing the old one; neither generation may join the other.
  try {
    await vi.waitFor(() => expect(tokenRequests()).toHaveLength(4));
  } finally {
    gate.resolve();
    await Promise.allSettled([oldRefresh, newRefresh]);
  }
  expect(await newRefresh).toMatchObject({ token: "new-refresh" });
  expect(tokenSchema.parse((await storage(stub)).tokens).access_token).toBe(
    "new-refresh",
  );
});

for (const action of ["models", "quota"] as const) {
  test(`${action} discovery after reauthorization does not join or retain an older generation`, async () => {
    const { stub, connection, ref } = await ready();
    const gate = deferred<void>();
    const method =
      action === "models"
        ? ":fetchAvailableModels"
        : ":retrieveUserQuotaSummary";
    override = async (request) => {
      if (!request.url.includes(method)) return;
      const old =
        request.headers.get("authorization") === "Bearer access-initial";
      if (old) await gate.promise;
      const id = old ? "old-inventory" : "new-inventory";
      return Response.json(
        action === "models"
          ? { models: { [id]: { displayName: id } } }
          : { groups: [{ id, displayName: id, buckets: [] }] },
      );
    };
    const oldRequest = stub.run({ action });
    await vi.waitFor(() =>
      expect(
        records.filter((record) => record.url.includes(method)),
      ).toHaveLength(1),
    );
    const next = await start(connection, ref);
    await complete(stub, next.session, "reauthorized");
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
    const newRequest = stub.run({ action });
    try {
      await vi.waitFor(() =>
        expect(
          records.filter((record) => record.url.includes(method)),
        ).toHaveLength(2),
      );
    } finally {
      gate.resolve();
      await Promise.allSettled([oldRequest, newRequest]);
    }
    const view = await accountReply(newRequest, accountViewSchema);
    expect(action === "models" ? view.models : view.quota.groups).toMatchObject(
      [{ id: "new-inventory" }],
    );
    const saved = await accountReply(
      stub.run({ action: "view" }),
      accountViewSchema,
    );
    expect(action === "models" ? saved.models : saved.quota.groups).toEqual(
      action === "models" ? view.models : view.quota.groups,
    );
  });
}

test("cancelling an in-flight exchange fences late tokens", async () => {
  const { stub, session } = await start();
  const gate = deferred<void>();
  override = async (request) => {
    if (!request.url.includes("/token")) return;
    await gate.promise;
    return Response.json({
      access_token: "late",
      refresh_token: "late-refresh",
      expires_in: 3600,
    });
  };
  const pending = complete(stub, session);
  await vi.waitFor(() => expect(tokenRequests()).toHaveLength(1));
  await stub.run({ action: "cancel", actor, session_id: sessionId(session) });
  gate.resolve();
  expect((await pending).status).toBe("cancelled");
  expect((await storage(stub)).tokens).toBeNull();
});

test("accounts remain bound to their provider and Google identity", async () => {
  const { stub, connection, ref } = await ready();
  await expect(
    resolve(stub, { ...connection, provider_id: "another" }),
  ).rejects.toThrow("another provider");
  expect(
    await stub.run({
      action: "start",
      account_ref: ref,
      actor,
      connection: { ...connection, provider_id: "another" },
    }),
  ).toMatchObject({ ok: false, status: 403 });
  const next = await start(connection, ref);
  override = (request) =>
    request.url.includes("/userinfo")
      ? Response.json({
          id: "different-google-user",
          email: "other@example.test",
        })
      : undefined;
  await complete(stub, next.session, "new-user");
  await runDurableObjectAlarm(stub);
  const session = await vi.waitFor(async () => {
    const reply = await accountReply(
      stub.run({
        action: "session",
        actor,
        session_id: sessionId(next.session),
      }),
      sessionViewSchema,
    );
    expect(reply.status).toBe("error");
    return reply;
  });
  expect(session.status).toBe("error");
  expect(session.error).toContain("different Google account");
  expect(await resolve(stub, connection)).toMatchObject({
    token: "access-initial",
  });
});

test("quota refresh uses a one-minute cache and failures retain the last good snapshot", async () => {
  const { stub, connection } = await ready();
  const initial = await accountReply(
    stub.run({ action: "quota" }),
    accountViewSchema,
  );
  expect(initial.quota).toMatchObject({
    stale: false,
    last_error: null,
    subscription: { tier_name: "Free" },
  });
  expect(initial.quota.groups[0].buckets[0].remaining_fraction).toBe(0.75);
  const count = records.length;
  await stub.run({ action: "quota" });
  expect(records).toHaveLength(count);
  override = (request) =>
    request.url.includes(":retrieveUserQuotaSummary")
      ? Response.json(
          { error: { message: "upstream denied" } },
          { status: 503 },
        )
      : undefined;
  const failed = await accountReply(
    stub.run({ action: "quota", force: true }),
    accountViewSchema,
  );
  expect(failed.quota.groups).toEqual(initial.quota.groups);
  expect(failed.quota.updated_at).toBe(initial.quota.updated_at);
  expect(failed.quota.stale).toBe(true);
  expect(failed.quota.last_error).toContain("503");
  expect(
    (await env.HEALTH.getByName(connection.provider_id).getStatus()).failures,
  ).toBe(0);
});

test("a malformed quota response does not discard a successful subscription refresh", async () => {
  const { stub } = await ready();
  const previous = await accountReply(
    stub.run({ action: "quota" }),
    accountViewSchema,
  );
  override = (request) => {
    if (request.url.includes(":retrieveUserQuotaSummary"))
      return Response.json({ unexpected: true });
    if (request.url.includes(":loadCodeAssist"))
      return Response.json({ paidTier: { id: "pro", name: "Pro" } });
    return;
  };
  const current = await accountReply(
    stub.run({ action: "quota", force: true }),
    accountViewSchema,
  );
  expect(current.quota.groups).toEqual(previous.quota.groups);
  expect(current.quota.updated_at).toBe(previous.quota.updated_at);
  expect(current.quota.subscription?.tier_name).toBe("Pro");
  expect(current.quota.last_error).toContain("no quota inventory");
  expect(current.quota.stale).toBe(true);
});

test("successful quotas survive failure to prepare the subscription request", async () => {
  const proxy = group();
  const connection = {
    provider_id: "antigravity",
    credential_id: "primary",
    provider_proxy_group: proxy.id,
  };
  const ref = crypto.randomUUID();
  await env.CODY_CONFIG_KV.put(
    "gateway-config",
    JSON.stringify(settings(connection, ref, [proxy])),
  );
  const { stub } = await ready(connection, ref);
  override = async (request) => {
    if (request.url.includes(":retrieveUserQuotaSummary"))
      await env.CODY_CONFIG_KV.delete("gateway-config");
    return;
  };
  const current = await accountReply(
    stub.run({ action: "quota" }),
    accountViewSchema,
  );
  expect(current.quota.groups[0]?.buckets[0]?.remaining_fraction).toBe(0.75);
  expect(current.quota.updated_at).not.toBeNull();
  expect(current.quota.last_error).toContain(
    "Publish the selected proxy group",
  );
  expect(current.quota.stale).toBe(true);
});

function settings(
  connection: ProviderConnection,
  ref: string,
  groups: ReturnType<typeof parseConfig>["proxy_groups"] = [],
) {
  return parseConfig({
    proxy_groups: groups,
    providers: [
      {
        type: "antigravity",
        id: connection.provider_id,
        proxy_group: connection.provider_proxy_group,
        models: ["native-model"],
        credentials: [
          {
            id: connection.credential_id,
            priority: 100,
            disabled: false,
            proxy_group: connection.credential_proxy_group,
            auth: { type: "oauth", account_ref: ref },
          },
        ],
        priority: 100,
        disabled: false,
      },
    ],
    api_keys: [
      {
        id: "client",
        api_key: "client-secret",
        providers: [connection.provider_id],
      },
    ],
    model_routes: { alias: { model: "native-model" } },
  });
}
function group() {
  return {
    id: crypto.randomUUID(),
    strategy: "sticky" as const,
    proxies: ["a", "b"].map((id, index) => ({
      id,
      priority: 100 - index,
      disabled: false,
      url: `socks5://${id}.test:1080`,
    })),
  };
}
async function infer(
  config: ReturnType<typeof parseConfig>,
  endpoint: "responses" | "messages" | "messages/count_tokens" = "responses",
  payload?: Record<string, unknown>,
) {
  const context = createExecutionContext();
  const response = await handleInference(
    new Request(`https://gateway.test/v1/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-secret",
      },
      body: JSON.stringify(
        payload ?? {
          model: "alias",
          ...(endpoint === "responses"
            ? { input: "hello" }
            : { messages: [{ role: "user", content: "hello" }] }),
        },
      ),
    }),
    env,
    config,
    config.api_keys[0],
    endpoint,
    crypto.randomUUID(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

for (const mode of ["inherit", "override", "direct"] as const) {
  test(`${mode} proxy selection covers authorization, refresh, identity, project, catalog, quota and inference`, async () => {
    const first = group();
    const second = group();
    second.proxies = second.proxies.map((node) => ({
      ...node,
      url: node.url.replace(".test", "-override.test"),
    }));
    const connection: ProviderConnection = {
      provider_id: "antigravity",
      credential_id: "primary",
      provider_proxy_group: first.id,
      ...(mode === "override"
        ? { credential_proxy_group: second.id }
        : mode === "direct"
          ? { credential_proxy_group: null }
          : {}),
    };
    const ref = crypto.randomUUID();
    const config = settings(connection, ref, [first, second]);
    await env.CODY_CONFIG_KV.put("gateway-config", JSON.stringify(config));
    override = (request) =>
      request.url.includes(":loadCodeAssist")
        ? Response.json({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          })
        : undefined;
    const { stub } = await ready(connection, ref);
    override = undefined;
    await stub.run({ action: "models" });
    await stub.run({ action: "quota", force: true });
    await expireToken(stub);
    await resolve(stub, connection, config.proxy_groups);
    expect((await infer(config)).status).toBe(200);
    for (const method of [
      "/token",
      "/userinfo",
      ":loadCodeAssist",
      ":onboardUser",
      ":fetchAvailableModels",
      ":retrieveUserQuotaSummary",
      ":generateContent",
    ])
      expect(records.some((record) => record.url.includes(method))).toBe(true);
    expect(
      records.every((record) =>
        mode === "direct"
          ? record.proxy === null
          : mode === "override"
            ? record.proxy?.includes("-override.test")
            : record.proxy !== null && !record.proxy.includes("-override.test"),
      ),
    ).toBe(true);
    if (mode !== "direct") {
      const selected = mode === "override" ? second : first;
      const status = await env.PROXY_GROUP.getByName(selected.id).getStatus(
        await proxyGroupSnapshot({}, selected),
      );
      expect(status.bindings).toHaveLength(1);
      expect(status.bindings[0].credential_id).toBe(
        mode === "override" ? "primary" : undefined,
      );
    }
  });
}

test("inference retries share one auth snapshot and one proxy switch budget", async () => {
  const selected = group();
  selected.strategy = "sticky";
  const connection = {
    provider_id: "antigravity",
    credential_id: "primary",
    provider_proxy_group: selected.id,
  };
  const ref = crypto.randomUUID();
  const config = settings(connection, ref, [selected]);
  await env.CODY_CONFIG_KV.put("gateway-config", JSON.stringify(config));
  const { stub } = await ready(connection, ref);
  const requests: string[] = [];
  let attempt = 0;
  // Break only the currently sticky node, then fail one application attempt.
  const bound = (
    await env.PROXY_GROUP.getByName(selected.id).getStatus(
      await proxyGroupSnapshot({}, selected),
    )
  ).bindings[0].proxy_id;
  vi.mocked(socksFetch).mockImplementation(async (request, proxy) => {
    requests.push(proxy.url);
    if (proxy.url === `socks5://${bound}.test:1080`)
      throw new SocksProxyError("SOCKS5 connection failed");
    attempt++;
    if (attempt === 1) {
      records.push({
        url: request.url,
        body: await request.clone().text(),
        authorization: request.headers.get("authorization"),
        proxy: proxy.url,
      });
      return new Response("retry", { status: 503 });
    }
    return send(request, proxy.url);
  });
  config.providers[0].retry = { status_codes: [503], delays_ms: [0] };
  const before = tokenRequests().length;
  expect((await infer(config)).status).toBe(200);
  expect(requests).toHaveLength(3);
  expect(requests[1]).toBe(requests[2]);
  const attempts = records.filter((record) =>
    record.url.includes(":generateContent"),
  );
  expect(attempts[0].body).toBe(attempts[1].body);
  expect(attempts[0].authorization).toBe(attempts[1].authorization);
  expect(tokenRequests()).toHaveLength(before);
  expect((await resolve(stub, connection, config.proxy_groups)).token).toBe(
    "access-initial",
  );
});

test("OAuth proxy faults cool shared proxy nodes without cooling the provider", async () => {
  const selected = group();
  const connection = {
    provider_id: "antigravity",
    credential_id: "primary",
    provider_proxy_group: selected.id,
  };
  await env.CODY_CONFIG_KV.put(
    "gateway-config",
    JSON.stringify(settings(connection, crypto.randomUUID(), [selected])),
  );
  vi.mocked(socksFetch).mockRejectedValue(
    new SocksProxyError("SOCKS5 connection failed"),
  );
  for (let i = 0; i < 3; i++) {
    const account = await start(connection);
    const progress = await complete(account.stub, account.session);
    expect(progress.status).toBe("error");
  }
  const status = await env.PROXY_GROUP.getByName(selected.id).getStatus(
    await proxyGroupSnapshot({}, selected),
  );
  expect(status.proxies.every((node) => node.status === "cooling")).toBe(true);
  expect(
    (await env.HEALTH.getByName(connection.provider_id).getStatus()).failures,
  ).toBe(0);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test("native catalog aggregation respects declared models, aliases and client permissions", async () => {
  const { stub, connection, ref } = await ready();
  const config = settings(connection, ref);
  await stub.run({ action: "models" });
  for (const [agent, expected] of [
    ["codex_cli", "models"],
    ["other", "data"],
    ["claude-code", "data"],
  ]) {
    const response = await handleModels(
      new Request("https://gateway.test/v1/models", {
        headers: { "user-agent": agent },
      }),
      env,
      config,
      config.api_keys[0],
    );
    expect(response.status).toBe(200);
    const payload = z
      .record(z.string(), z.unknown())
      .parse(await response.json());
    const models = z
      .array(z.record(z.string(), z.unknown()))
      .parse(payload[expected]);
    expect(models.map((model) => model.id ?? model.slug).sort()).toEqual([
      "alias",
      "native-model",
    ]);
    expect(JSON.stringify(models)).not.toContain("hidden");
    if (agent === "claude-code")
      expect(models[0]).toMatchObject({
        max_input_tokens: 1000000,
        max_tokens: 64000,
      });
  }
  const forbidden = await handleModels(
    new Request("https://gateway.test/v1/models"),
    env,
    config,
    { ...config.api_keys[0], providers: [] },
  );
  expect(forbidden.status).not.toBe(200);
});

test("catalog authentication shares the three-second deadline without cancelling a shared refresh", async () => {
  const { stub, connection, ref } = await ready();
  await expireToken(stub);
  const gate = deferred<void>();
  override = async (request) => {
    if (!request.url.includes("/token")) return;
    await gate.promise;
    return Response.json({
      access_token: "after-catalog-timeout",
      expires_in: 3600,
    });
  };
  const config = settings(connection, ref);
  const started = Date.now();
  const response = await handleModels(
    new Request("https://gateway.test/v1/models"),
    env,
    config,
    config.api_keys[0],
  );
  expect(response.status).toBe(502);
  expect(Date.now() - started).toBeLessThan(4000);
  gate.resolve();
  expect(await resolve(stub, connection)).toMatchObject({
    token: "after-catalog-timeout",
  });
  expect(
    (
      await env.HEALTH.getByName(
        `${connection.provider_id}:catalog`,
      ).getStatus()
    ).failures,
  ).toBe(0);
  expect(
    (await env.HEALTH.getByName(connection.provider_id).getStatus()).failures,
  ).toBe(0);
});

test("native gateway supports both HTTP/SSE dialects and count_tokens", async () => {
  const { connection, ref } = await ready();
  const config = settings(connection, ref);
  for (const endpoint of ["responses", "messages"] as const)
    for (const stream of [false, true]) {
      const response = await infer(config, endpoint, {
        model: "alias",
        stream,
        ...(endpoint === "responses"
          ? { input: "hello" }
          : { messages: [{ role: "user", content: "hello" }], max_tokens: 50 }),
      });
      expect(response.status).toBe(200);
      if (stream)
        expect(await response.text()).toContain(
          endpoint === "responses" ? "response.completed" : "message_stop",
        );
      else
        expect(await response.json()).toMatchObject(
          endpoint === "responses"
            ? { object: "response", model: "alias" }
            : { type: "message", model: "alias", stop_reason: "end_turn" },
        );
    }
  expect(await (await infer(config, "messages/count_tokens")).json()).toEqual({
    input_tokens: 12,
  });
});

const admin = (
  path: string,
  method = "GET",
  json?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(
    `http://localhost/console/api${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-cody-admin": "1",
        ...headers,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    },
    env,
    createExecutionContext(),
  );

test("admin does not expose OAuth client registration endpoints", async () => {
  for (const method of ["GET", "PUT"]) {
    const response = await admin(
      "/oauth/clients/antigravity",
      method,
      method === "PUT" ? { client_secret: "unused", version: 0 } : undefined,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(
    await env.CODY_DB.prepare("SELECT 1 FROM oauth_clients").first(),
  ).toBeNull();
});

test("admin OAuth sessions require current drafts and published proxy references", async () => {
  const connection = { provider_id: "antigravity", credential_id: "one" };
  expect(
    (
      await admin(
        "/oauth/sessions",
        "POST",
        { ...connection, version: 0 },
        { origin: "https://attacker.test" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await admin("/oauth/sessions", "POST", { ...connection, version: 4 }))
      .status,
  ).toBe(409);
  expect(
    (
      await admin("/oauth/sessions", "POST", {
        ...connection,
        version: 0,
        provider_proxy_group: "unpublished",
      })
    ).status,
  ).toBe(409);
  const opened = await admin("/oauth/sessions", "POST", {
    ...connection,
    version: 0,
  });
  const session = sessionViewSchema.parse(await opened.json());
  expect(opened.status).toBe(200);
  const other = await admin("/oauth/sessions", "POST", {
    ...connection,
    provider_id: "different",
    version: 0,
    account_ref: session.account_ref,
  });
  expect(other.status).toBe(400);
  expect(
    (
      await admin("/oauth/sessions", "POST", {
        ...connection,
        version: 0,
        account_ref: crypto.randomUUID(),
      })
    ).status,
  ).toBe(404);
  expect(
    (await admin(`/oauth/sessions/${session.id}`, "DELETE", {})).status,
  ).toBe(200);
  expect(
    (
      await admin(`/oauth/sessions/${session.id}/callback`, "POST", {
        redirect_url: callback(session),
      })
    ).status,
  ).toBe(410);
});

test("fixed provider settings and proxy groups publish before the first account is authorized", async () => {
  const proxy = group();
  const connection = {
    provider_id: "antigravity",
    credential_id: "primary",
    provider_proxy_group: proxy.id,
  };
  const config = settings(connection, crypto.randomUUID(), [proxy]);
  Object.assign(config.providers[0], {
    disabled: true,
    credentials: [],
    models: [],
  });
  config.model_routes = {};
  const response = await admin("/config", "PUT", { config, version: 0 });
  expect(response.status).toBe(200);
  const saved = draftViewSchema.parse(await response.json());
  expect(saved.valid).toBe(true);
  expect(saved.config.providers[0]).toMatchObject({
    id: "antigravity",
    disabled: true,
    credentials: [],
    models: [],
    proxy_group: proxy.id,
  });
  const published = await admin("/config/publish", "POST", {
    version: saved.version,
  });
  expect(published.status).toBe(200);
  const opened = await admin("/oauth/sessions", "POST", {
    ...connection,
    version: saved.version,
  });
  expect(opened.status).toBe(200);
  const session = sessionViewSchema.parse(await opened.json());
  expect(session.account.provider_id).toBe("antigravity");
  const exchanged = await admin(
    `/oauth/sessions/${session.id}/callback`,
    "POST",
    { redirect_url: callback(session) },
  );
  expect(exchanged.status).toBe(200);
  await initialize(env.PROVIDER_OAUTH_ACCOUNT.getByName(session.account_ref));
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((record) => record.proxy !== null)).toBe(true);
});

test("enabled native drafts remain editable but require accounts and models before publication", async () => {
  const { connection, ref } = await ready();
  const complete = settings(connection, ref);
  const incomplete = structuredClone(complete);
  incomplete.providers[0].models = [];
  incomplete.providers[0].credentials = [];
  incomplete.model_routes = {};
  const saved = await control().save(incomplete, 0, actor);
  expect(saved.valid).toBe(false);
  expect(saved.validation_error).toContain("select Antigravity models");
  const blocked = await admin("/config/publish", "POST", {
    version: saved.version,
  });
  expect(blocked.status).toBe(400);
  expect(await env.CODY_CONFIG_KV.get("gateway-config")).toBeNull();
  const withModels = structuredClone(incomplete);
  withModels.providers[0].models = complete.providers[0].models;
  const pendingAccount = await control().save(withModels, saved.version, actor);
  expect(pendingAccount.valid).toBe(false);
  expect(pendingAccount.validation_error).toContain(
    "add an Antigravity account",
  );
  const finished = await control().save(
    complete,
    pendingAccount.version,
    actor,
  );
  expect(finished.valid).toBe(true);
  expect(
    (await admin("/config/publish", "POST", { version: finished.version }))
      .status,
  ).toBe(200);
  expect((await infer(complete)).status).toBe(200);
});

test("configuration references are stable and rollback never rolls back runtime tokens", async () => {
  const { stub, connection, ref } = await ready();
  const config = settings(connection, ref);
  const foreign = await ready({ ...connection, provider_id: "another" });
  await expect(
    control().save(settings(connection, foreign.ref), 0, actor),
  ).rejects.toThrow("authorized for this provider");
  const draft = await control().save(config, 0, actor);
  expect(draft.config.providers[0].credentials[0].auth).toEqual({
    type: "oauth",
    account_ref: ref,
  });
  const publisher = env.CONFIG_PUBLISHER.getByName("configuration");
  const first = z
    .object({
      ok: z.literal(true),
      data: z.object({ version: z.number(), published_revision: z.number() }),
    })
    .parse(JSON.parse(await publisher.publish(draft.version, actor)));
  const denied = await admin(
    `/config/providers/${connection.provider_id}/credentials/primary/reveal`,
    "POST",
    { version: first.data.version },
  );
  expect(denied.status).toBe(400);
  const reauth = await start(connection, ref);
  await complete(stub, reauth.session, "new-token");
  for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
  const rollback = await publisher.rollback(
    first.data.published_revision,
    first.data.version,
    actor,
  );
  expect(JSON.parse(rollback)).toMatchObject({ ok: true });
  expect(await resolve(stub, connection)).toMatchObject({
    token: "access-new-token",
  });
  const published = await env.CODY_CONFIG_KV.get("gateway-config");
  expect(published).not.toContain("access-new-token");
  expect(published).not.toContain("refresh-token");
  await stub.run({ action: "disconnect" });
  await expect(resolve(stub, connection)).rejects.toThrow("Reconnect");
});

test("batch quotas retain successful account results alongside missing-account errors", async () => {
  const { ref } = await ready();
  const missing = crypto.randomUUID();
  const response = await admin("/provider-accounts/quota", "POST", {
    account_refs: [ref, missing],
    force: true,
  });
  expect(response.status).toBe(200);
  const payload = z
    .object({
      items: z.array(
        z.object({
          account_ref: z.string(),
          account: accountViewSchema.nullable(),
          error: z.string().nullable(),
        }),
      ),
    })
    .parse(await response.json());
  expect(payload.items[0].account?.quota.stale).toBe(false);
  expect(payload.items[1].error).toBeTruthy();
});
