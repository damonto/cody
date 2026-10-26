import assert from "node:assert/strict";
import test from "node:test";
import { accountProvider } from "../src/providers/oauth/registry.ts";
import { AccountInventory } from "../src/providers/oauth/inventory.ts";
import { storedSchema } from "../src/providers/oauth/state.ts";
import { OAuthError } from "../src/providers/oauth/schema.ts";
import { ProviderOAuthAccountCore } from "../src/providers/oauth/account.ts";
import { decryptConfig, encryptConfig } from "../src/control/crypto.ts";
import { setImmediate } from "node:timers/promises";

function fixture() {
  let account = storedSchema.parse({
    account_ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    provider_id: "claude",
    provider_type: "claude",
    generation: 1,
    status: "ready",
    connection: { provider_id: "claude", credential_id: "credential" },
    tokens: {
      access_token: "original-access",
      refresh_token: "original-refresh",
      expires_at: Date.now() + 3600000,
    },
    identity: { id: "account", email: null },
    project_id: null,
    claude: {
      account_id: "account",
      organization_id: "organization",
      organization_name: null,
      subscription_type: "max",
      rate_limit_tier: null,
    },
    error: null,
    session: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: {
      groups: [],
      subscription: null,
      updated_at: null,
      last_error: null,
      stale: true,
    },
  });
  const state = {
    current: () => account,
    async update(generation, apply) {
      if (generation !== account.generation)
        throw new OAuthError("Account changed", 409, "account_changed");
      const next = structuredClone(account);
      await apply(next);
      account = storedSchema.parse(next);
    },
    async resolve() {
      return {
        token: account.tokens.access_token,
        generation: account.generation,
        claude_organization_id: "organization",
      };
    },
  };
  const services = {
    async outbound() {
      return [
        async (request) => {
          if (request.url.endsWith("/oauth/token"))
            return Response.json({
              access_token: "late-access",
              refresh_token: "late-refresh",
              expires_in: 3600,
            });
          assert.ok(request.url.endsWith("/api/oauth/usage"));
          return Response.json({
            five_hour: {
              utilization: 12,
              resets_at: new Date(Date.now() + 60000).toISOString(),
            },
          });
        },
        new AbortController().signal,
      ];
    },
  };
  return { state, provider: () => accountProvider("claude", state, services) };
}

test("provider refresh commits against the operation's generation even if a replacement already exists", async () => {
  const f = fixture();
  const { tokens, generation } = f.state.current();
  await f.state.update(generation, (account) => {
    account.generation++;
    account.tokens = {
      ...tokens,
      access_token: "replacement-access",
      refresh_token: "replacement-refresh",
    };
  });
  const replacement = structuredClone(f.state.current());
  await assert.rejects(f.provider().refresh(generation, tokens), {
    code: "account_changed",
  });
  assert.deepEqual(f.state.current(), replacement);
});

test("a queued inventory refresh cannot update the replacement generation or its errors", async () => {
  const f = fixture();
  let run;
  const inventory = new AccountInventory(
    {
      ...f.state,
      refresh(_kind, _generation, operation) {
        const { promise, resolve, reject } = Promise.withResolvers();
        run = () => operation().then(resolve, reject);
        return promise;
      },
    },
    () => f.provider().inventory,
  );
  const pending = inventory.refreshQuota(true);
  await f.state.update(1, (account) => {
    account.generation++;
  });
  const replacement = structuredClone(f.state.current());
  await run();
  await pending;
  assert.deepEqual(f.state.current(), replacement);
});

test("account snapshots cannot bypass persistence and failed commits preserve the previous snapshot", async () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const initial = fixture().state.current();
  let stored = new Map([["account", await encryptConfig(initial, key)]]);
  let failWrites = false;
  const initializing = [];
  const core = new ProviderOAuthAccountCore(
    {
      storage: {
        get: async (key) => stored.get(key),
        async transaction(run) {
          const next = new Map(stored);
          await run({
            put: async (key, value) => next.set(key, value),
            deleteAlarm: async () => {},
          });
          if (failWrites) throw new Error("Storage unavailable");
          stored = next;
        },
      },
      blockConcurrencyWhile: (run) => {
        const operation = run();
        initializing.push(operation);
        return operation;
      },
      waitUntil: () => {},
    },
    { CONFIG_ENCRYPTION_KEY: key, LOG_LEVEL: "silent" },
  );
  await Promise.all(initializing);
  const view = async () => {
    const reply = await core.run({ action: "view" });
    assert.equal(reply.ok, true);
    return reply.data;
  };
  const before = await view();
  assert.throws(() => before.models.push({ id: "bypass" }), TypeError);
  assert.throws(() => {
    before.claude.organization_id = "another";
  }, TypeError);

  const observed = { id: "five_hour", label: "Five hours", buckets: [] };
  const observe = (group) =>
    core.run({
      action: "claude_usage",
      generation: initial.generation,
      groups: [group],
    });
  assert.equal((await observe(observed)).ok, true);
  assert.deepEqual(before.quota.groups, []);
  const committed = await view();
  assert.deepEqual(committed.quota.groups, [observed]);
  assert.throws(() => {
    committed.quota.groups[0].label = "bypass";
  }, TypeError);
  const ciphertext = stored.get("account");
  assert.deepEqual((await decryptConfig(ciphertext, key)).quota.groups, [
    observed,
  ]);

  failWrites = true;
  assert.equal((await observe({ ...observed, id: "seven_day" })).ok, false);
  assert.equal(stored.get("account"), ciphertext);
  assert.deepEqual(await view(), committed);

  await core.transferReload();
  const reloaded = await view();
  assert.deepEqual(reloaded, committed);
  assert.throws(() => reloaded.quota.groups.push(observed), TypeError);
});

async function refreshDuringAuthorizationFixture(send, options = {}) {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const initial = structuredClone(options.account ?? fixture().state.current());
  if (!options.account) initial.tokens.expires_at = Date.now() - 1000;
  let stored = new Map([["account", await encryptConfig(initial, key)]]);
  const initializing = [];
  const pending = [];
  const core = new ProviderOAuthAccountCore(
    {
      storage: {
        get: async (name) => stored.get(name),
        async transaction(run) {
          const next = new Map(stored);
          await run({
            put: async (name, value) => next.set(name, value),
            setAlarm: async () => {},
            deleteAlarm: async () => {},
          });
          if (options.beforeCommit)
            await options.beforeCommit(
              await decryptConfig(next.get("account"), key),
            );
          stored = next;
        },
      },
      blockConcurrencyWhile(run) {
        const result = run();
        initializing.push(result);
        return result;
      },
      waitUntil: (promise) => pending.push(promise),
    },
    {
      CONFIG_ENCRYPTION_KEY: key,
      LOG_LEVEL: "off",
      CODY_CONFIG_KV: {
        get: async () =>
          JSON.stringify({
            version: "2.9.1",
            expires_at: Date.now() + 6 * 3600_000,
          }),
      },
      CODY_DB: {
        batch: async (statements) => statements.map(() => ({ results: [] })),
        prepare: () => ({
          bind() {
            return this;
          },
          run: async () => ({ meta: { changes: 1 }, results: [] }),
          first: async () => ({ version: 0, maintenance: 0, updated_at: 0 }),
        }),
      },
      UPSTREAM_HTTP: { direct: send, antigravity: send },
    },
  );
  await Promise.all(initializing);
  return {
    core,
    initial,
    resolve: {
      action: "resolve",
      connection: initial.connection,
      proxy_configuration: { proxy_groups: [] },
    },
    stored: async () =>
      storedSchema.parse(await decryptConfig(stored.get("account"), key)),
    drain: () => Promise.all(pending),
  };
}

function authorizationAccount(type, refreshToken) {
  const account = structuredClone(fixture().state.current());
  account.provider_type = type;
  account.provider_id = type;
  account.connection.provider_id = type;
  account.claude = type === "claude" ? account.claude : null;
  account.identity.id = type === "xai" ? "subject" : "account:organization";
  if (type === "antigravity") {
    account.identity.id = "google-user";
    account.project_id = "existing-project";
  }
  const claims =
    type === "xai"
      ? { sub: "subject", iss: "https://auth.x.ai" }
      : {
          "https://api.openai.com/auth": {
            chatgpt_account_id: "account",
            chatgpt_user_id: "organization",
          },
        };
  const idToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  account.tokens = {
    ...account.tokens,
    id_token: idToken,
    expires_at: Date.now() - 1000,
  };
  if (type === "codex")
    account.codex = {
      account_id: "account",
      user_id: "organization",
      plan_type: null,
      subscription_active_until: null,
    };
  if (type === "xai") account.xai = { subject: "subject" };
  account.session = {
    id: crypto.randomUUID(),
    actor: "admin",
    status: "initializing",
    state: "",
    verifier: "",
    challenge: "",
    expires_at: Date.now() + 600_000,
    connection: account.connection,
    error: null,
    tokens: {
      access_token: "replacement-access",
      refresh_token: refreshToken,
      id_token: idToken,
      expires_at: Date.now() + 3600_000,
    },
    identity: account.identity,
    next_at: Date.now(),
    flow: "pkce",
  };
  return storedSchema.parse(account);
}

function authorizationUpstream(account, token) {
  return async (request) => {
    if (request.url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        device_authorization_endpoint: "https://auth.x.ai/device",
        token_endpoint: "https://auth.x.ai/token",
      });
    if (request.url.endsWith("/api/oauth/profile"))
      return Response.json({
        account: { uuid: "account" },
        organization: { uuid: "organization" },
      });
    assert.ok(request.url.endsWith("/token"));
    return token(request, {
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      id_token: account.tokens.id_token,
    });
  };
}

for (const type of ["claude", "codex", "xai"]) {
  for (const refreshToken of [undefined, "original-refresh"]) {
    test(`${type} authorization ${refreshToken ? "repeating" : "omitting"} a refresh token waits for its rotation`, async () => {
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const account = authorizationAccount(type, refreshToken);
      const f = await refreshDuringAuthorizationFixture(
        authorizationUpstream(account, async (_request, grant) => {
          started.resolve();
          await release.promise;
          return Response.json(grant);
        }),
        { account },
      );
      const refresh = f.core.run(f.resolve);
      await started.promise;
      let initialized = false;
      const initialize = f.core.alarm().then(() => {
        initialized = true;
      });
      await setImmediate();
      assert.equal(initialized, false);
      release.resolve();
      assert.equal((await refresh).ok, true);
      await initialize;
      const stored = await f.stored();
      assert.equal(stored.generation, account.generation + 1);
      assert.equal(stored.tokens.access_token, "replacement-access");
      assert.equal(stored.tokens.refresh_token, "rotated-refresh");
      await f.core.transferReload();
      assert.equal(
        (await f.core.run(f.resolve)).data.token,
        "replacement-access",
      );
      await f.drain();
    });
  }

  test(`${type} authorization with an independent refresh token fences an older rotation`, async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const account = authorizationAccount(type, "replacement-refresh");
    const f = await refreshDuringAuthorizationFixture(
      authorizationUpstream(account, async (_request, grant) => {
        started.resolve();
        await release.promise;
        return Response.json(grant);
      }),
      { account },
    );
    const refresh = f.core.run(f.resolve);
    await started.promise;
    try {
      await f.core.alarm();
      assert.equal(
        (await f.stored()).tokens.refresh_token,
        "replacement-refresh",
      );
    } finally {
      release.resolve();
    }
    assert.equal((await refresh).code, "account_changed");
    assert.equal(
      (await f.stored()).tokens.refresh_token,
      "replacement-refresh",
    );
    await f.drain();
  });
}

test("an inherited credential commit prevents a new forced refresh until its durable write finishes", async () => {
  const committing = Promise.withResolvers();
  const release = Promise.withResolvers();
  const account = authorizationAccount("codex");
  account.tokens.expires_at = Date.now() + 3600_000;
  let requests = 0;
  const f = await refreshDuringAuthorizationFixture(
    authorizationUpstream(account, async (_request, grant) => {
      requests++;
      return Response.json(grant);
    }),
    {
      account,
      async beforeCommit(next) {
        if (next.generation !== account.generation + 1) return;
        committing.resolve();
        await release.promise;
      },
    },
  );
  const initialize = f.core.alarm();
  await committing.promise;
  const refresh = f.core.run({
    ...f.resolve,
    action: "codex_refresh",
    generation: account.generation,
    token: account.tokens.access_token,
  });
  await setImmediate();
  assert.equal(requests, 0);
  release.resolve();
  await initialize;
  assert.equal((await refresh).code, "account_changed");
  assert.equal(requests, 0);
  assert.equal((await f.stored()).tokens.refresh_token, "original-refresh");
  await f.drain();
});

for (const action of ["disconnect", "invalid_grant"]) {
  test(`${action} prevents a waiting authorization from inheriting revoked credentials`, async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const account = authorizationAccount("claude");
    const f = await refreshDuringAuthorizationFixture(
      authorizationUpstream(account, async (_request, grant) => {
        started.resolve();
        await release.promise;
        return action === "invalid_grant"
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json(grant);
      }),
      { account },
    );
    const refresh = f.core.run(f.resolve);
    await started.promise;
    const initialize = f.core.alarm();
    await setImmediate();
    if (action === "disconnect")
      assert.equal((await f.core.run({ action })).ok, true);
    release.resolve();
    await Promise.all([refresh, initialize]);
    const stored = await f.stored();
    assert.equal(
      stored.status,
      action === "disconnect" ? "disconnected" : "needs_reauthorization",
    );
    assert.notEqual(stored.tokens?.access_token, "replacement-access");
    await f.drain();
  });
}

test("a grant repeating the token captured before exchange inherits a concurrent completed rotation", async () => {
  const refreshStarted = Promise.withResolvers();
  const releaseRefresh = Promise.withResolvers();
  const exchangeStarted = Promise.withResolvers();
  const releaseExchange = Promise.withResolvers();
  const account = authorizationAccount("claude");
  account.session.status = "pending";
  account.session.state = "oauth-state";
  account.session.tokens = null;
  const f = await refreshDuringAuthorizationFixture(
    authorizationUpstream(account, async (request, grant) => {
      const body = await request.json();
      if (body.grant_type === "refresh_token") {
        refreshStarted.resolve();
        await releaseRefresh.promise;
        return Response.json(grant);
      }
      exchangeStarted.resolve();
      await releaseExchange.promise;
      return Response.json({
        ...grant,
        access_token: "replacement-access",
        refresh_token: "original-refresh",
      });
    }),
    { account },
  );
  const refresh = f.core.run(f.resolve);
  await refreshStarted.promise;
  const exchange = f.core.run({
    action: "complete",
    session_id: account.session.id,
    actor: "admin",
    redirect_url: "code#oauth-state",
  });
  await exchangeStarted.promise;
  releaseRefresh.resolve();
  assert.equal((await refresh).ok, true);
  releaseExchange.resolve();
  assert.equal((await exchange).ok, true);
  assert.equal((await f.stored()).session.tokens.refresh_token, undefined);
  await f.core.transferReload();
  await f.core.alarm();
  assert.equal((await f.stored()).tokens.refresh_token, "rotated-refresh");
  await f.drain();
});

for (const refreshProject of [false, true]) {
  test(`Antigravity inherited project ${refreshProject ? "refreshes through" : "retains"} the active token lifecycle`, async () => {
    const account = authorizationAccount("antigravity");
    if (refreshProject) account.session.tokens.expires_at = Date.now() - 1000;
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let refreshes = 0;
    const f = await refreshDuringAuthorizationFixture(
      async (request) => {
        if (request.url.includes("/token")) {
          refreshes++;
          assert.equal(
            new URLSearchParams(await request.text()).get("refresh_token"),
            "original-refresh",
          );
          started.resolve();
          await release.promise;
          return Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          });
        }
        assert.ok(request.url.endsWith(":loadCodeAssist"));
        return Response.json({
          cloudaicompanionProject: "replacement-project",
        });
      },
      { account },
    );
    await f.core.alarm();
    const staged = (await f.stored()).antigravity_initialization;
    assert.equal(staged.inherit_refresh_token, true);
    assert.equal(staged.tokens.refresh_token, undefined);
    await f.core.transferReload();
    const refresh = f.core.run(f.resolve);
    await Promise.race([
      started.promise,
      refresh.then((result) => {
        throw new Error(
          `Refresh did not reach upstream: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const project = f.core.alarm();
    await setImmediate();
    assert.equal(refreshes, 1);
    release.resolve();
    await Promise.all([refresh, project]);
    const stored = await f.stored();
    assert.equal(stored.tokens.refresh_token, "rotated-refresh");
    assert.equal(stored.project_id, "replacement-project");
    assert.equal(stored.antigravity_initialization, null);
    await f.drain();
  });
}

test("Antigravity pending project progress cannot restore a refresh token rotated during the poll", async () => {
  const account = authorizationAccount("antigravity");
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await refreshDuringAuthorizationFixture(
    async (request) => {
      if (request.url.includes("/token"))
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      if (request.url.endsWith(":loadCodeAssist")) {
        started.resolve();
        await release.promise;
        return Response.json({});
      }
      assert.ok(request.url.endsWith(":onboardUser"));
      return Response.json({
        done: true,
        response: { cloudaicompanionProject: "replacement-project" },
      });
    },
    { account },
  );
  await f.core.alarm();
  const project = f.core.alarm();
  await started.promise;
  assert.equal((await f.core.run(f.resolve)).ok, true);
  release.resolve();
  await project;
  assert.equal(
    (await f.stored()).antigravity_initialization.tokens.refresh_token,
    undefined,
  );
  await f.core.transferReload();
  await f.core.alarm();
  assert.equal((await f.stored()).tokens.refresh_token, "rotated-refresh");
  await f.drain();
});

for (const legacy of ["same", "different", "no_active"]) {
  test(`legacy Antigravity project with ${legacy} refresh-token ownership recovers safely`, async () => {
    const account = authorizationAccount("antigravity");
    account.antigravity_initialization = {
      tokens: {
        ...account.session.tokens,
        refresh_token:
          legacy === "different" ? "ambiguous-refresh" : "original-refresh",
      },
      identity: account.identity,
      connection: account.connection,
      stage: "project",
      tier: "free-tier",
      attempts: 0,
      next_at: Date.now(),
      deadline: Date.now() + 600_000,
      error: null,
      last_result: null,
    };
    account.session.status = "complete";
    account.session.tokens = null;
    if (legacy === "no_active") {
      account.tokens = null;
      account.status = "disconnected";
    }
    let requests = 0;
    const f = await refreshDuringAuthorizationFixture(
      async (request) => {
        requests++;
        assert.ok(request.url.endsWith(":loadCodeAssist"));
        return Response.json({
          cloudaicompanionProject: "replacement-project",
        });
      },
      { account },
    );
    await f.core.alarm();
    const stored = await f.stored();
    if (legacy === "different") {
      assert.equal(requests, 0);
      assert.match(
        stored.antigravity_initialization.error,
        /Start authorization again/,
      );
      assert.deepEqual(stored.tokens, account.tokens);
      await f.core.transferReload();
      assert.equal(
        (await f.core.run({ action: "readiness" })).data.ready,
        true,
      );
    } else {
      assert.equal(stored.project_id, "replacement-project");
      assert.equal(stored.tokens.refresh_token, "original-refresh");
    }
    await f.drain();
  });
}

for (const transition of ["start", "cancel", "expire"]) {
  test(`authorization ${transition} preserves a successful in-flight token rotation`, async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let refreshes = 0;
    const f = await refreshDuringAuthorizationFixture(async (request) => {
      assert.ok(request.url.endsWith("/oauth/token"));
      assert.equal((await request.json()).refresh_token, "original-refresh");
      refreshes++;
      started.resolve();
      await release.promise;
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    });
    const refreshing = f.core.run(f.resolve);
    await started.promise;
    try {
      const session = await f.core.run({
        action: "start",
        account_ref: f.initial.account_ref,
        actor: "admin",
        connection: f.initial.connection,
        provider_type: "claude",
        flow: "pkce",
      });
      assert.equal(session.ok, true);
      if (transition === "cancel")
        assert.equal(
          (
            await f.core.run({
              action: "cancel",
              actor: "admin",
              session_id: session.data.id.split(".")[1],
            })
          ).ok,
          true,
        );
      if (transition === "expire") {
        t.mock.timers.setTime(now + 11 * 60_000);
        assert.equal((await f.core.run({ action: "view" })).ok, true);
      }
      assert.equal((await f.stored()).generation, f.initial.generation);
    } finally {
      release.resolve();
    }
    const result = await refreshing;
    assert.equal(result.ok, true);
    assert.equal(result.data.token, "rotated-access");
    const committed = await f.stored();
    assert.equal(committed.tokens.refresh_token, "rotated-refresh");
    assert.equal(committed.generation, f.initial.generation);
    assert.equal(
      committed.session.status,
      { start: "pending", cancel: "cancelled", expire: "expired" }[transition],
    );
    await f.core.transferReload();
    assert.equal((await f.core.run(f.resolve)).data.token, "rotated-access");
    assert.equal(refreshes, 1);
    await f.drain();
  });
}

test("Codex mode validation runs in the fenced write after a concurrent authorization commits", async (t) => {
  const initial = authorizationAccount("codex", "new-native-refresh");
  initial.status = "disconnected";
  initial.codex = null;
  initial.identity = null;
  initial.tokens = null;
  const f = await refreshDuringAuthorizationFixture(
    async () => {
      throw new Error("No upstream request expected");
    },
    { account: initial },
  );
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let paused = false;
  t.mock.method(crypto.subtle, "digest", async (...args) => {
    if (!paused) {
      paused = true;
      started.resolve();
      await release.promise;
    }
    return digest(...args);
  });
  const starting = f.core.run({
    action: "start",
    account_ref: initial.account_ref,
    actor: "admin",
    connection: initial.connection,
    provider_type: "codex",
    flow: "siwc",
  });
  await started.promise;
  try {
    await f.core.alarm();
  } finally {
    release.resolve();
  }
  const result = await starting;
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  const committed = await f.stored();
  assert.equal(committed.codex.mode, "native");
  assert.equal(committed.tokens.access_token, "replacement-access");
  assert.equal(committed.session.status, "complete");
});
