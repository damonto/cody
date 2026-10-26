import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  SiwcClient,
  SIWC_SCOPE,
  SIWC_REDIRECT_URI,
  siwcAuthorizationUrl,
} from "../src/providers/codex/siwc.ts";
import { validateSiwcRequest } from "../src/providers/codex/siwc-policy.ts";
import { codexAdapter } from "../src/providers/codex/index.ts";
import { siwcAccount } from "../src/providers/codex/siwc-account.ts";
import { storedSchema, emptyQuota } from "../src/providers/oauth/state.ts";
import { readAccountSnapshot } from "../src/providers/oauth/reads.ts";
import {
  codexUsageLimitFromError,
  siwcUsageLimitResponse,
} from "../src/providers/codex/limits.ts";
import { inspectCodexResponse } from "../src/providers/codex/inspect.ts";
import { siwcHostId } from "../src/providers/codex/siwc-host.ts";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";

const issuer = "https://auth.openai.com";
const metadata = {
  issuer,
  token_endpoint: `${issuer}/api/accounts/oauth/token`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
};
const pair = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(pair.publicKey)),
  kid: "siwc-test",
  alg: "RS256",
};
async function signed(claims = {}, key = pair.privateKey) {
  return new SignJWT({
    nonce: "nonce",
    email: "operator@example.test",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "siwc-test" })
    .setIssuer(issuer)
    .setAudience("oaiapp_test")
    .setSubject("subject")
    .setExpirationTime("1h")
    .sign(key);
}
const pending = () => ({
  id: crypto.randomUUID(),
  state: "state",
  verifier: "verifier",
  challenge: "challenge",
  siwc: {
    authorization_generation: 1,
    nonce: "nonce",
    host_id: "urn:uuid:test-host",
    client_id: null,
    consent: false,
  },
});
function transport(options = {}) {
  const requests = [];
  return {
    requests,
    async send(request) {
      requests.push(request.clone());
      if (request.url.endsWith("/openid-configuration"))
        return Response.json(options.metadata ?? metadata);
      if (request.url.endsWith("/jwks.json"))
        return Response.json({ keys: [jwk] });
      if (request.url.endsWith("/token"))
        return Response.json(
          {
            access_token: "access",
            refresh_token: "rotated",
            id_token: await signed(options.claims),
            expires_in: 3600,
            token_type: "Bearer",
            scope: SIWC_SCOPE,
            ...options.tokens,
          },
          { status: options.status ?? 200 },
        );
      if (request.url.endsWith("/revoke")) return new Response(null);
      throw new Error(`Unexpected request ${request.url}`);
    },
  };
}

test("SIWC dynamic registration uses Cody, PKCE, nonce and an exact loopback redirect", () => {
  const session = pending();
  const url = new URL(siwcAuthorizationUrl(session));
  assert.equal(url.origin + url.pathname, `${issuer}/api/accounts/authorize`);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "Cody");
  assert.equal(url.searchParams.get("redirect_uri"), SIWC_REDIRECT_URI);
  assert.equal(url.searchParams.get("nonce"), "nonce");
  assert.equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
  session.siwc.client_id = "oaiapp_test";
  assert.equal(
    new URL(siwcAuthorizationUrl(session)).searchParams.has("agent_name_hint"),
    false,
  );
  assert.equal(
    new URL(siwcAuthorizationUrl(session)).searchParams.has("prompt"),
    false,
  );
  session.siwc.consent = true;
  assert.equal(
    new URL(siwcAuthorizationUrl(session)).searchParams.get("prompt"),
    "consent",
  );
});

test("code exchange verifies a signed token and refresh uses its issued registration", async () => {
  const f = transport();
  const client = new SiwcClient(f.send, new AbortController().signal);
  const grant = await client.exchange("code", "oaiapp_test", pending());
  assert.deepEqual(grant.identity, {
    subject: "subject",
    email: "operator@example.test",
  });
  const exchange = new URLSearchParams(
    await f.requests
      .find((request) => request.url === metadata.token_endpoint)
      .clone()
      .text(),
  );
  assert.equal(exchange.get("client_id"), "oaiapp_test");
  assert.equal(exchange.get("redirect_uri"), SIWC_REDIRECT_URI);
  assert.equal(exchange.get("code_verifier"), "verifier");
  assert.equal(exchange.has("client_secret"), false);
  await client.refresh("refresh", "oaiapp_test", "subject");
  const forms = await Promise.all(
    f.requests
      .filter((request) => request.url === metadata.token_endpoint)
      .map((request) => request.clone().text()),
  );
  const refresh = new URLSearchParams(forms.at(-1));
  assert.equal(refresh.get("resource"), "https://api.openai.com/v1");
  assert.equal(refresh.has("scope"), false);
  await client.revoke("rotated", "oaiapp_test");
  assert.equal(
    new URLSearchParams(await f.requests.at(-1).text()).get("token_type_hint"),
    "refresh_token",
  );
});

for (const [name, claims] of [
  ["nonce", { nonce: "other" }],
  ["audience", { aud: "other" }],
  ["issuer", { iss: "https://attacker.test" }],
  ["expiry", { exp: 1 }],
  ["subject", { sub: "" }],
]) {
  test(`SIWC rejects an invalid ${name}`, async () => {
    const token = await new SignJWT({
      sub: "subject",
      aud: "oaiapp_test",
      iss: issuer,
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: "nonce",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "siwc-test" })
      .sign(pair.privateKey);
    const f = transport({ tokens: { id_token: token } });
    await assert.rejects(
      new SiwcClient(f.send, new AbortController().signal).exchange(
        "code",
        "oaiapp_test",
        pending(),
      ),
    );
  });
}
test("SIWC rejects forged signatures and discovery credential redirection", async () => {
  const wrong = await generateKeyPair("RS256");
  const f = transport({
    tokens: { id_token: await signed({}, wrong.privateKey) },
  });
  await assert.rejects(
    new SiwcClient(f.send, new AbortController().signal).exchange(
      "code",
      "oaiapp_test",
      pending(),
    ),
  );
  const redirected = transport({
    metadata: { ...metadata, token_endpoint: "https://attacker.test/token" },
  });
  await assert.rejects(
    new SiwcClient(redirected.send, new AbortController().signal).exchange(
      "code",
      "oaiapp_test",
      pending(),
    ),
  );
  assert.equal(redirected.requests.length, 1);
});

const valid = { model: "gpt-test", input: [], stream: true, store: false };
test("SIWC validates HTTP/WS independently and preserves unknown input", () => {
  const body = {
    ...valid,
    future_option: { nested: true },
    tools: [{ type: "namespace", tools: [{ type: "function", name: "test" }] }],
  };
  const copy = structuredClone(body);
  validateSiwcRequest({
    endpoint: "responses",
    transport: "http",
    payload: body,
  });
  assert.deepEqual(body, copy);
  for (const [field, value] of [
    ["stream", false],
    ["store", true],
    ["input", "text"],
    ["temperature", 0],
    ["previous_response_id", "resp_old"],
    ["tools", [{ type: "tool_search" }]],
    ["tools", [{ type: "function" }]],
    ["input", [{ role: "system", content: "test" }]],
  ])
    assert.throws(
      () =>
        validateSiwcRequest({
          endpoint: "responses",
          transport: "http",
          payload: { ...valid, [field]: value },
        }),
      (error) => error.status === 400 && error.param.startsWith(field),
    );
  const ws = {
    input: [],
    store: false,
    previous_response_id: "same-connection",
  };
  validateSiwcRequest({
    endpoint: "responses",
    transport: "websocket",
    payload: ws,
  });
  assert.throws(() =>
    validateSiwcRequest({
      endpoint: "responses",
      transport: "websocket",
      payload: { ...ws, stream: true },
    }),
  );
  assert.throws(() =>
    validateSiwcRequest({
      endpoint: "responses/compact",
      transport: "http",
      payload: valid,
    }),
  );
});

test("SIWC adapter never forwards native workspace authentication and filters hidden models", async () => {
  const credential = {
    mode: "siwc",
    type: "oauth",
    provider: "codex",
    account_ref: crypto.randomUUID(),
    siwc_subject: "subject",
    generation: 1,
    token: "access",
  };
  const request = new Request(
    "https://gateway.test/v1/responses?custom=preserved",
    {
      headers: {
        authorization: "Bearer client-secret",
        "chatgpt-account-id": "wrong",
        "x-openai-fedramp": "true",
        "x-app": "unchanged",
      },
    },
  );
  const prepared = codexAdapter.prepare({}, credential, {
    request,
    endpoint: "responses",
    transport: "http",
    payload: valid,
  });
  assert.equal(
    prepared.url,
    "https://api.openai.com/v1/responses?custom=preserved",
  );
  assert.equal(prepared.body, undefined);
  assert.equal(prepared.headers.get("authorization"), "Bearer access");
  assert.equal(prepared.headers.has("chatgpt-account-id"), false);
  assert.equal(prepared.headers.has("x-openai-fedramp"), false);
  assert.equal(prepared.headers.get("x-app"), "unchanged");
  const models = codexAdapter.prepare({}, credential, {
    request,
    endpoint: "models",
    transport: "http",
  });
  assert.deepEqual(
    models
      .parseModels({
        models: [
          { slug: "shown", visibility: "list" },
          { slug: "hidden", visibility: "hide" },
        ],
      })
      .data.map((model) => model.id),
    ["shown"],
  );
});

test("SIWC quota cooldown honors Retry-After without inventing a subscription reset", async () => {
  const error = {
    error: { code: "subscription_sharing_usage_limit_exceeded" },
  };
  const now = Date.now();
  assert.equal(
    codexUsageLimitFromError(error, () => null, now, "siwc").resets_at,
    now + 60_000,
  );
  assert.equal(
    codexUsageLimitFromError(
      error,
      (name) => (name === "retry-after" ? "120" : null),
      now,
      "siwc",
    ).resets_at,
    now + 120_000,
  );
  assert.equal(
    codexUsageLimitFromError(error, () => null, now, "native"),
    undefined,
  );
  const bytes = JSON.stringify(error);
  const inspection = await inspectCodexResponse(
    new Response(bytes, {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
    { mode: "siwc", signal: new AbortController().signal },
  );
  assert.equal(inspection.usageLimit.code, error.error.code);
  assert.equal(await inspection.response.text(), bytes);
  const synthetic = await siwcUsageLimitResponse("request").json();
  assert.equal("resets_at" in synthetic.error, false);
});

test("host identity is stable across concurrent SQL callers and stays deployment-local", async () => {
  const open = async () => {
    const db = await createSqliteDatabase(":memory:");
    await db.exec(
      await readFile(
        new URL("../migrations/d1/0017_siwc_host.sql", import.meta.url),
        "utf8",
      ),
    );
    return db;
  };
  const db = await open();
  const other = await open();
  try {
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => siwcHostId(db)),
    );
    assert.equal(new Set(ids).size, 1);
    assert.notEqual(ids[0], await siwcHostId(other));
  } finally {
    await db.close();
    await other.close();
  }
});

function accountFixture(options = {}) {
  const session = {
    ...pending(),
    actor: "operator",
    status: "pending",
    expires_at: Date.now() + 600000,
    connection: { provider_id: "codex", credential_id: "credential" },
    error: null,
    tokens: null,
    identity: null,
    next_at: Date.now(),
    flow: "siwc",
    device_auth_id: null,
    user_code: null,
    poll_interval_ms: 5000,
  };
  let account = storedSchema.parse({
    account_ref: crypto.randomUUID(),
    provider_id: "codex",
    provider_type: "codex",
    generation: 0,
    authorization_generation: 1,
    status: "disconnected",
    connection: session.connection,
    tokens: null,
    identity: null,
    project_id: null,
    codex: null,
    session,
    error: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: emptyQuota(),
  });
  const update = async (field, generation, change) => {
    assert.equal(account[field], generation, "generation fence");
    const next = structuredClone(account);
    await change(next);
    account = storedSchema.parse(next);
  };
  const network = transport(options);
  const state = {
    current: () => account,
    update: (generation, run) => update("generation", generation, run),
    updateAuthorization: (generation, run) =>
      update("authorization_generation", generation, run),
    replaceCredentials: (generation, _inherit, run) =>
      update("authorization_generation", generation, run),
  };
  const provider = siwcAccount(state, {
    outbound: async () => [network.send, new AbortController().signal],
    hostId: async () => "urn:uuid:stable-host",
  });

  return { state, provider, network, update };
}

test("registration state excludes other identities and direct permission gates readiness", async () => {
  for (const enabled of [true, false]) {
    const f = accountFixture();
    await f.provider.authorization.siwc.prepare(
      f.state.current().session,
      false,
    );
    const session = f.state.current().session;
    const registration = {
      issuer,
      subject: "subject",
      client_id: "oaiapp_test",
      scopes: enabled ? SIWC_SCOPE.split(" ") : ["openid"],
    };
    await f.update("authorization_generation", 1, (account) => {
      account.codex_quota_sync.full_observed_at = 123;
      account.session.status = "initializing";
      account.session.siwc.registration = registration;
      account.session.tokens = {
        access_token: "secret-access",
        refresh_token: "secret-refresh",
        expires_at: Date.now() + 3600000,
      };
    });
    await f.provider.authorization.initialize();
    const current = f.state.current();
    assert.equal(current.codex_quota_sync.full_observed_at, 0);
    assert.equal(current.codex.mode, "siwc");
    assert.equal(current.codex.account_id, null);
    assert.equal(current.codex.plan_usage_enabled, enabled);
    assert.deepEqual(
      readAccountSnapshot(current, { action: "readiness" }).data,
      { ready: enabled, codex_mode: "siwc" },
    );
    assert.equal(
      JSON.stringify(readAccountSnapshot(current, { action: "view" })).includes(
        "secret-access",
      ),
      false,
    );
    assert.equal(current.session.siwc, undefined);
    // Same email and subject cannot replace a different issued registration.
    await f.update("generation", current.generation, (account) => {
      account.session = {
        ...session,
        status: "initializing",
        siwc: {
          ...session.siwc,
          registration: { ...registration, client_id: "oaiapp_other" },
        },
        tokens: {
          access_token: "new",
          refresh_token: "new-refresh",
          expires_at: Date.now() + 3600000,
        },
      };
    });
    await assert.rejects(
      f.provider.authorization.initialize(),
      /different ChatGPT registration/,
    );
    assert.equal(f.state.current().tokens.access_token, "secret-access");
  }
});

test("SIWC callback rejects missing, duplicate and changed issued IDs before token exchange", async () => {
  const f = accountFixture();
  await f.provider.authorization.siwc.prepare(f.state.current().session, false);
  for (const query of [
    "",
    "client_id=dynamic_agent_client",
    "client_id=a&client_id=b",
  ])
    await assert.rejects(
      f.provider.authorization.siwc.exchange(
        "code",
        f.state.current().session,
        new URL(`${SIWC_REDIRECT_URI}?${query}`),
      ),
    );
  assert.equal(f.network.requests.length, 0);
  await f.update("authorization_generation", 1, (account) => {
    account.session.siwc.client_id = "oaiapp_test";
  });
  await assert.rejects(
    f.provider.authorization.siwc.exchange(
      "code",
      f.state.current().session,
      new URL(`${SIWC_REDIRECT_URI}?client_id=oaiapp_other`),
    ),
  );
});

test("native automatic resets ignore SIWC credentials excluded by the current request", async () => {
  const { ProviderHealthCore } =
    await import("../src/gateway/health/provider-health.ts");
  const { recordCredentialQuotaCooldown, getCredentialAvailability } =
    await import("../src/gateway/health/health.ts");
  const { restoreCodexAccount } =
    await import("../src/providers/codex/exhaustion.ts");
  const { parseConfig } = await import("../src/config/store.ts");
  const { accountViewSchema } =
    await import("../src/providers/oauth/schema.ts");
  const nativeRef = crypto.randomUUID();
  const siwcRef = crypto.randomUUID();
  const config = parseConfig({
    providers: [
      {
        id: "codex",
        type: "codex",
        disabled: false,
        auto_consume_resets: true,
        priority: 100,
        models: ["gpt-test"],
        credentials: [nativeRef, siwcRef].map((ref, index) => ({
          id: `credential-${index}`,
          priority: 100,
          disabled: false,
          auth: { type: "oauth", account_ref: ref },
        })),
      },
    ],
    api_keys: [],
  });
  const provider = config.providers[0];
  const view = accountViewSchema.parse({
    account_ref: nativeRef,
    provider_id: provider.id,
    status: "ready",
    email: null,
    project_id: null,
    codex: {
      account_id: "native-workspace",
      user_id: null,
      plan_type: null,
      subscription_active_until: null,
    },
    expires_at: Date.now() + 3600000,
    error: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: {
      ...emptyQuota(),
      reset_credits: {
        available_count: 1,
        error: null,
        updated_at: Date.now(),
        credits: [
          {
            id: "mock-credit",
            reset_type: null,
            status: "available",
            granted_at: null,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            title: null,
            description: null,
          },
        ],
      },
    },
  });
  let consumed = 0;
  const objects = new Map();
  const env = {
    LOG_LEVEL: "off",
    HEALTH: {
      getByName(name) {
        if (!objects.has(name)) {
          const values = new Map();
          const storage = {
            get: async (key) => values.get(key),
            put: async (key, value) => {
              values.set(key, value);
            },
            delete: async (key) => values.delete(key),
            transaction: async (run) => run(storage),
          };
          objects.set(
            name,
            new ProviderHealthCore({ storage }, { LOG_LEVEL: "off" }),
          );
        }
        return objects.get(name);
      },
    },
    PROVIDER_OAUTH_ACCOUNT: {
      getByName(ref) {
        assert.equal(ref, nativeRef);
        return {
          async run(command) {
            if (command.action === "consume_reset") {
              consumed++;
              return {
                ok: true,
                data: {
                  result: { code: "reset", windows_reset: 1 },
                  account: view,
                },
              };
            }
            assert.equal(command.action, "reset_credits");
            return { ok: true, data: view };
          },
        };
      },
    },
  };
  const until = Date.now() + 600000;
  await recordCredentialQuotaCooldown(env, provider.id, "credential-0", until);
  const selection = {
    checks: [],
    credentialChecks: [
      {
        provider_id: provider.id,
        credential_id: "credential-0",
        available: false,
        reason: "cooling",
        codex_mode: "native",
        cooldown_reason: "quota",
        cooling_until: until,
      },
      {
        provider_id: provider.id,
        credential_id: "credential-1",
        available: false,
        reason: "request_unsupported",
        codex_mode: "siwc",
      },
    ],
  };
  assert.equal(
    await restoreCodexAccount(
      env,
      config,
      [{ provider, credentials: provider.credentials }],
      selection,
      new Set(),
      true,
      "mock-reset",
    ),
    true,
  );
  assert.equal(consumed, 1);
  assert.equal(
    (await getCredentialAvailability(env, provider.id, "credential-0"))
      .available,
    true,
  );
});

test("SIWC metadata preserves non-JSON rejection statuses for authentication recovery", async () => {
  for (const status of [401, 403, 503]) {
    const client = new SiwcClient(
      async () => new Response("upstream rejected the request", { status }),
      new AbortController().signal,
    );
    await assert.rejects(
      client.models("access"),
      (error) => error.status === status,
    );
  }
  const client = new SiwcClient(
    async () => new Response("invalid successful JSON"),
    new AbortController().signal,
  );
  await assert.rejects(
    client.models("access"),
    (error) => error.status === 502,
  );
});

test("SIWC code exchange requires the pending nonce before any network I/O", async () => {
  const f = transport();
  const session = pending();
  delete session.siwc;
  await assert.rejects(
    new SiwcClient(f.send, new AbortController().signal).exchange(
      "code",
      "oaiapp_test",
      session,
    ),
    (error) => error.status === 409,
  );
  assert.equal(f.requests.length, 0);
});
