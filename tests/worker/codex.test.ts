import { setTestConfiguration } from "../helpers/worker-configuration.ts";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { decryptConfig, encryptConfig } from "../../src/control/crypto.ts";
import { app } from "../../src/worker.ts";
import { parseConfig } from "../../src/config/store.ts";
import { handleInference } from "../../src/gateway/http/proxy.ts";
import { getCredentialAvailability } from "../../src/gateway/health/health.ts";
import {
  accountReply,
  accountViewSchema,
  resolvedOAuthSchema,
  sessionViewSchema,
  type ProviderConnection,
  type SessionView,
} from "../../src/providers/oauth/schema.ts";

type Account = ReturnType<Env["PROVIDER_OAUTH_ACCOUNT"]["getByName"]>;
type Config = ReturnType<typeof parseConfig>;
const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const actor = "admin@example.test";
const MODEL = "gpt-5.5-codex";

interface Sent {
  url: string;
  body: string;
  account: string | null;
  authorization: string | null;
  fedramp: string | null;
}
const sent: Sent[] = [];
/** Seconds until reset, per ChatGPT workspace account that is out of quota. */
const exhausted = new Map<string, number>();
const consumed: Record<string, unknown>[] = [];
let devicePolls = 0;
let resetCredits: Record<string, unknown>[] = [];

function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}
function idToken(code: string) {
  return jwt({
    ...(code !== "no-email" ? { email: `${code}@example.test` } : {}),
    "https://api.openai.com/auth": {
      chatgpt_account_id: `acct-${code}`,
      chatgpt_plan_type: "plus",
      ...(code === "fedramp" ? { chatgpt_account_is_fedramp: true } : {}),
    },
  });
}

async function send(request: Request): Promise<Response> {
  const body = request.body
    ? new TextDecoder().decode(await request.clone().arrayBuffer())
    : "";
  const account = request.headers.get("chatgpt-account-id");
  sent.push({
    url: request.url,
    body,
    account,
    authorization: request.headers.get("authorization"),
    fedramp: request.headers.get("x-openai-fedramp"),
  });
  const url = new URL(request.url);
  if (url.href === "https://auth.openai.com/oauth/token") {
    const fields = new URLSearchParams(body);
    const code = fields.get("code") ?? "refreshed";
    return Response.json({
      access_token: `access-${code}`,
      refresh_token: `refresh-${code}`,
      id_token: idToken(code),
      expires_in: 3600,
    });
  }
  if (url.pathname === "/api/accounts/deviceauth/usercode")
    return Response.json({
      device_auth_id: "device-auth",
      user_code: "ABCD-1234",
      interval: "5",
    });
  if (url.pathname === "/api/accounts/deviceauth/token")
    return ++devicePolls < 2
      ? Response.json({ error: "authorization_pending" }, { status: 403 })
      : Response.json({
          authorization_code: "device",
          code_verifier: "device-verifier",
        });
  if (url.pathname === "/backend-api/wham/usage")
    return Response.json({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 18000 },
      },
    });
  if (url.pathname === "/backend-api/wham/rate-limit-reset-credits")
    return Response.json({ credits: resetCredits });
  if (url.pathname === "/backend-api/wham/rate-limit-reset-credits/consume") {
    consumed.push(JSON.parse(body));
    if (account) exhausted.delete(account);
    return Response.json({ code: "reset", windows_reset: 1 });
  }
  if (url.pathname === "/backend-api/codex/responses") {
    const seconds = account ? exhausted.get(account) : undefined;
    if (seconds !== undefined)
      return Response.json(
        {
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            resets_in_seconds: seconds,
          },
        },
        { status: 429 },
      );
    return Response.json({ id: "resp", object: "response", account });
  }
  throw new Error(`Unexpected test request: ${request.url}`);
}

beforeAll(() => applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  consumed.length = 0;
  exhausted.clear();
  devicePolls = 0;
  resetCredits = [];
  await env.CODY_CONFIG_KV.delete("gateway-config");
  vi.stubGlobal(
    "fetch",
    vi.fn((request: Request) => send(request)),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(
  credentialId: string,
  flow: "pkce" | "device" = "pkce",
  ref = crypto.randomUUID(),
) {
  const connection: ProviderConnection = {
    provider_id: "codex",
    credential_id: credentialId,
  };
  const stub = env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
  const session = await accountReply(
    stub.run({
      action: "start",
      actor,
      account_ref: ref,
      connection,
      provider_type: "codex",
      flow,
    }),
    sessionViewSchema,
  );
  return { stub, session, connection, ref };
}
const sessionId = (session: SessionView) => session.id.split(".")[1];
function callback(session: SessionView, code: string) {
  const state = new URL(session.url!).searchParams.get("state")!;
  return `http://localhost:1455/auth/callback?${new URLSearchParams({ state, code })}`;
}
async function settle(stub: Account) {
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
/** A ready account whose workspace ID is `acct-<credential ID>`. */
async function ready(credentialId: string) {
  const account = await start(credentialId);
  await accountReply(
    account.stub.run({
      action: "complete",
      actor,
      session_id: sessionId(account.session),
      redirect_url: callback(account.session, credentialId),
    }),
    sessionViewSchema,
  );
  await settle(account.stub);
  return account;
}
/** Credential IDs are unique per test, so health and rotation start clean. */
async function accounts(count: number) {
  const prefix = crypto.randomUUID().slice(0, 8);
  return Promise.all(
    Array.from({ length: count }, (_, index) => ready(`${prefix}-${index}`)),
  );
}
function codexConfig(
  refs: { connection: ProviderConnection; ref: string }[],
  options: Record<string, unknown> = {},
): Config {
  return parseConfig({
    providers: [
      {
        type: "codex",
        id: "codex",
        models: [MODEL],
        priority: 100,
        disabled: false,
        credentials: refs.map(({ connection, ref }) => ({
          id: connection.credential_id,
          priority: 100,
          disabled: false,
          auth: { type: "oauth", account_ref: ref },
        })),
        ...options,
      },
    ],
    api_keys: [
      { id: "client", api_key: "client-secret", providers: ["codex"] },
    ],
  });
}
async function infer(config: Config, session?: string) {
  const context = createExecutionContext();
  const response = await handleInference(
    new Request("https://gateway.test/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-secret",
        ...(session ? { "session-id": session } : {}),
      },
      body: JSON.stringify({ model: MODEL, input: "hello", stream: false }),
    }),
    env,
    config,
    config.api_keys[0],
    "responses",
    crypto.randomUUID(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
const inferences = () =>
  sent.filter((record) => record.url.endsWith("/codex/responses"));
async function servedBy(config: Config, session?: string) {
  const response = await infer(config, session);
  expect(response.status).toBe(200);
  return ((await response.json()) as { account: string }).account;
}

test("PKCE authorization turns the ID token into a ChatGPT workspace credential", async () => {
  const { stub, connection } = await ready("pkce");
  const view = await accountReply(
    stub.run({ action: "view" }),
    accountViewSchema,
  );
  expect(view).toMatchObject({
    provider_id: "codex",
    status: "ready",
    email: "pkce@example.test",
    codex: { account_id: "acct-pkce", plan_type: "plus" },
  });
  const exchange = new URLSearchParams(sent[0].body);
  expect(exchange.get("redirect_uri")).toBe(
    "http://localhost:1455/auth/callback",
  );
  expect(exchange.get("code_verifier")).toBeTruthy();
  expect(
    await accountReply(
      stub.run({
        action: "resolve",
        connection,
        proxy_configuration: { proxy_groups: [] },
      }),
      resolvedOAuthSchema,
    ),
  ).toEqual({ token: "access-pkce", account_id: "acct-pkce" });
});

test("device-code authorization polls until approval and exchanges the returned verifier", async () => {
  const { stub, session } = await start("device", "device");
  expect(session).toMatchObject({
    flow: "device",
    status: "pending",
    user_code: "ABCD-1234",
    verification_uri: "https://auth.openai.com/codex/device",
  });
  await expect(
    stub.run({
      action: "complete",
      actor,
      session_id: sessionId(session),
      redirect_url: "http://localhost:1455/auth/callback?code=x&state=y",
    }),
  ).resolves.toMatchObject({ ok: false });
  await runDurableObjectAlarm(stub);
  expect(
    await accountReply(
      stub.run({ action: "session", actor, session_id: sessionId(session) }),
      sessionViewSchema,
    ),
  ).toMatchObject({ status: "pending", user_code: "ABCD-1234" });
  const view = await settle(stub);
  expect(view.codex?.account_id).toBe("acct-device");
  const exchange = new URLSearchParams(
    sent.find((record) => record.url.endsWith("/oauth/token"))!.body,
  );
  expect(exchange.get("code")).toBe("device");
  expect(exchange.get("code_verifier")).toBe("device-verifier");
  expect(exchange.get("redirect_uri")).toBe(
    "https://auth.openai.com/deviceauth/callback",
  );
});

test("an exhausted account cools until its reset and the request is resent on the next one", async () => {
  const [first, second] = await accounts(2);
  const config = codexConfig([first, second], {
    account_selection: "session_affinity",
  });
  const firstAccount = `acct-${first.connection.credential_id}`;
  const secondAccount = `acct-${second.connection.credential_id}`;
  exhausted.set(firstAccount, 600);
  sent.length = 0;
  const before = Date.now();
  expect(await servedBy(config)).toBe(secondAccount);
  const attempts = inferences();
  expect(attempts.map((record) => record.account)).toEqual([
    firstAccount,
    secondAccount,
  ]);
  expect(attempts[1].body).toBe(attempts[0].body);
  expect(attempts[1].authorization).toBe(
    `Bearer access-${second.connection.credential_id}`,
  );
  const health = await getCredentialAvailability(
    env,
    "codex",
    first.connection.credential_id,
  );
  expect(health).toMatchObject({ available: false, cooldown_reason: "quota" });
  expect(health.cooling_until).toBeGreaterThanOrEqual(before + 600_000);
  expect(health.cooling_until).toBeLessThanOrEqual(Date.now() + 600_000);
  // The cooling account is skipped without another upstream attempt.
  sent.length = 0;
  expect(await servedBy(config)).toBe(secondAccount);
  expect(inferences()).toHaveLength(1);
});

test("when every account is exhausted Codex receives a usage-limit error with the earliest reset", async () => {
  const [first, second] = await accounts(2);
  const config = codexConfig([first, second]);
  exhausted.set(`acct-${first.connection.credential_id}`, 600);
  exhausted.set(`acct-${second.connection.credential_id}`, 120);
  sent.length = 0;
  const last = await infer(config);
  expect(last.status).toBe(429);
  expect(await last.json()).toMatchObject({
    error: { type: "usage_limit_reached" },
  });
  expect(inferences()).toHaveLength(2);

  sent.length = 0;
  const blocked = await infer(config);
  expect(inferences()).toHaveLength(0);
  expect(blocked.status).toBe(429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(100);
  expect(retryAfter).toBeLessThanOrEqual(121);
  const { error } = (await blocked.json()) as {
    error: { type: string; resets_in_seconds: number; resets_at: number };
  };
  expect(error.type).toBe("usage_limit_reached");
  expect(error.resets_in_seconds).toBe(retryAfter);
  expect(error.resets_at * 1000).toBeLessThan(Date.now() + 121_000);
});

test("round robin spreads new sessions across accounts and keeps each session on its account", async () => {
  const pool = await accounts(3);
  const config = codexConfig(pool);
  const sessions = ["one", "two", "three"].map(
    (name) => `${name}-${crypto.randomUUID()}`,
  );
  const assigned: string[] = [];
  for (const session of sessions)
    assigned.push(await servedBy(config, session));
  expect(new Set(assigned).size).toBe(3);
  for (const [index, session] of sessions.entries())
    expect(await servedBy(config, session)).toBe(assigned[index]);
});

test("session affinity fills the first account and moves a session only when it runs out", async () => {
  const [first, second] = await accounts(2);
  const config = codexConfig([first, second], {
    account_selection: "session_affinity",
  });
  const firstAccount = `acct-${first.connection.credential_id}`;
  const secondAccount = `acct-${second.connection.credential_id}`;
  const [one, two] = [crypto.randomUUID(), crypto.randomUUID()];
  expect(await servedBy(config, one)).toBe(firstAccount);
  expect(await servedBy(config, two)).toBe(firstAccount);
  exhausted.set(firstAccount, 300);
  expect(await servedBy(config, one)).toBe(secondAccount);
  exhausted.delete(firstAccount);
  // The session stays on its new account; the other one moves once cooling is seen.
  expect(await servedBy(config, one)).toBe(secondAccount);
  expect(await servedBy(config, two)).toBe(secondAccount);
});

test("automatic resets spend the earliest expiring credit only when enabled", async () => {
  const [only] = await accounts(1);
  const account = `acct-${only.connection.credential_id}`;
  const day = 86_400_000;
  resetCredits = [
    {
      id: "late",
      status: "available",
      expires_at: new Date(Date.now() + 9 * day).toISOString(),
    },
    {
      id: "soon",
      status: "available",
      expires_at: new Date(Date.now() + 2 * day).toISOString(),
    },
    {
      id: "spent",
      status: "redeemed",
      expires_at: new Date(Date.now() + day).toISOString(),
    },
  ];
  exhausted.set(account, 900);
  expect((await infer(codexConfig([only]))).status).toBe(429);
  expect(consumed).toHaveLength(0);

  const config = codexConfig([only], { auto_consume_resets: true });
  expect(await servedBy(config)).toBe(account);
  expect(consumed).toHaveLength(1);
  expect(consumed[0]).toMatchObject({ credit_id: "soon" });
  expect(consumed[0].redeem_request_id).toEqual(expect.any(String));
  expect(
    await getCredentialAvailability(
      env,
      "codex",
      only.connection.credential_id,
    ),
  ).toMatchObject({ available: true });
});

const admin = (path: string, method = "GET", json?: unknown) =>
  app.request(
    `http://localhost/console/api${path}`,
    {
      method,
      headers: { "content-type": "application/json", "x-cody-admin": "1" },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    },
    env,
    createExecutionContext(),
  );

test("the console shows quota cooldowns and a manual reset clears them", async () => {
  const [only] = await accounts(1);
  const config = codexConfig([only]);
  await setTestConfiguration(
    env.CODY_DB,
    "gateway-config",
    JSON.stringify(config),
  );
  exhausted.set(`acct-${only.connection.credential_id}`, 900);
  expect((await infer(config)).status).toBe(429);
  const health = await admin("/provider-accounts/health?provider_id=codex");
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({
    items: [
      {
        credential_id: only.connection.credential_id,
        account_ref: only.ref,
        available: false,
        cooldown_reason: "quota",
      },
    ],
  });

  const redeem = crypto.randomUUID();
  const reset = await admin(
    `/provider-accounts/${only.ref}/reset-credits/consume`,
    "POST",
    { redeem_request_id: redeem },
  );
  expect(reset.status).toBe(200);
  expect(await reset.json()).toMatchObject({ result: { code: "reset" } });
  expect(consumed).toEqual([{ redeem_request_id: redeem }]);
  expect(
    await (await admin("/provider-accounts/health?provider_id=codex")).json(),
  ).toMatchObject({ items: [{ available: true, cooling_until: null }] });
  expect(await servedBy(config)).toBe(`acct-${only.connection.credential_id}`);
});

test("PKCE accepts only the exact documented onboarding state suffix", async () => {
  const { stub, session } = await start("onboarding");
  const redirect = new URL(callback(session, "onboarding"));
  const state = redirect.searchParams.get("state")!;
  for (const suffix of [
    ".onboarding_entrypoint=unknown",
    ".onboarding_entrypoint=life_sciences.extra",
  ]) {
    redirect.searchParams.set("state", state + suffix);
    await expect(
      stub.run({
        action: "complete",
        actor,
        session_id: sessionId(session),
        redirect_url: redirect.toString(),
      }),
    ).resolves.toMatchObject({ ok: false });
  }
  redirect.searchParams.set(
    "state",
    state + ".onboarding_entrypoint=life_sciences",
  );
  await accountReply(
    stub.run({
      action: "complete",
      actor,
      session_id: sessionId(session),
      redirect_url: redirect.toString(),
    }),
    sessionViewSchema,
  );
  expect((await settle(stub)).codex?.account_id).toBe("acct-onboarding");
});

test("accounts without email survive eviction and FedRAMP credentials reach inference and quota", async () => {
  for (const code of ["no-email", "fedramp"]) {
    const account = await ready(code);
    await evictDurableObject(account.stub);
    const view = await accountReply(
      account.stub.run({ action: "view" }),
      accountViewSchema,
    );
    expect(view.email).toBe(
      code === "no-email" ? null : "fedramp@example.test",
    );
    expect(await servedBy(codexConfig([account]))).toBe(`acct-${code}`);
    await accountReply(
      account.stub.run({ action: "quota", force: true }),
      accountViewSchema,
    );
    for (const request of sent.filter(
      (entry) => entry.account === `acct-${code}`,
    ))
      expect(request.fedramp).toBe(code === "fedramp" ? "true" : null);
  }
});

async function expireAccessToken(stub: Account) {
  await runInDurableObject(stub, async (_instance, state) => {
    const record = z.record(z.string(), z.unknown());
    const ciphertext = await state.storage.get<string>("account");
    if (!ciphertext) throw new Error("Missing account");
    const stored = record.parse(
      await decryptConfig(ciphertext, env.CONFIG_ENCRYPTION_KEY),
    );
    stored.tokens = {
      ...record.parse(stored.tokens),
      expires_at: Date.now() - 1,
    };
    await state.storage.put(
      "account",
      await encryptConfig(stored, env.CONFIG_ENCRYPTION_KEY),
    );
  });
  await evictDurableObject(stub);
}

test("partial refresh survives eviction and rejects a changed workspace before storing its token", async () => {
  const account = await ready("refresh-partial");
  await expireAccessToken(account.stub);
  vi.stubGlobal("fetch", async (request: Request) =>
    request.url.endsWith("/oauth/token")
      ? Response.json({ refresh_token: "rotated" })
      : send(request),
  );
  const command = {
    action: "resolve" as const,
    connection: account.connection,
    proxy_configuration: { proxy_groups: [] },
  };
  expect(
    await accountReply(account.stub.run(command), resolvedOAuthSchema),
  ).toEqual({
    token: "access-refresh-partial",
    account_id: "acct-refresh-partial",
  });
  await evictDurableObject(account.stub);
  vi.stubGlobal("fetch", async (request: Request) =>
    request.url.endsWith("/oauth/token")
      ? Response.json({
          access_token: "wrong-account-token",
          id_token: idToken("someone-else"),
        })
      : send(request),
  );
  expect(await account.stub.run(command)).toMatchObject({
    ok: false,
    code: "invalid_grant",
  });
  expect(
    (
      await accountReply(
        account.stub.run({ action: "view" }),
        accountViewSchema,
      )
    ).status,
  ).toBe("needs_reauthorization");
});

test("an ambiguous automatic reset retries the same credit and idempotency key after takeover", async () => {
  const [account] = await accounts(1);
  exhausted.set(`acct-${account.connection.credential_id}`, 900);
  resetCredits = [
    {
      id: "original",
      status: "available",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    },
  ];
  let fail = true;
  vi.stubGlobal("fetch", async (request: Request) => {
    if (request.url.endsWith("/rate-limit-reset-credits/consume") && fail) {
      consumed.push(await request.json());
      return Response.json({ error: "lost response" }, { status: 503 });
    }
    return send(request);
  });
  const config = codexConfig([account], { auto_consume_resets: true });
  expect((await infer(config)).status).toBe(429);
  expect(consumed).toHaveLength(1);
  const coordinator = env.HEALTH.getByName("rotation:codex");
  await runInDurableObject(coordinator, async (_instance, state) => {
    const lease =
      await state.storage.get<Record<string, unknown>>("lease:codex-reset");
    await state.storage.put("lease:codex-reset", { ...lease, until: 0 });
  });
  await evictDurableObject(coordinator);
  resetCredits = [
    {
      id: "different",
      status: "available",
      expires_at: new Date(Date.now() + 10000).toISOString(),
    },
  ];
  fail = false;
  expect(await servedBy(config)).toBe(
    `acct-${account.connection.credential_id}`,
  );
  expect(consumed).toHaveLength(2);
  expect(consumed[1]).toEqual(consumed[0]);
});

test("concurrent new sessions rotate atomically and duplicate frames retain one binding", async () => {
  const list = await accounts(3);
  const config = codexConfig(list);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      servedBy(config, `parallel-${crypto.randomUUID()}-${index}`),
    ),
  );
  for (const account of list)
    expect(
      results.filter((id) => id === `acct-${account.connection.credential_id}`),
    ).toHaveLength(4);
  const session = `same-${crypto.randomUUID()}`;
  const duplicates = await Promise.all(
    Array.from({ length: 5 }, () => servedBy(config, session)),
  );
  expect(new Set(duplicates).size).toBe(1);
  const next = await servedBy(config, `next-${crypto.randomUUID()}`);
  const index = list.findIndex(
    (account) => `acct-${account.connection.credential_id}` === duplicates[0],
  );
  expect(next).toBe(
    `acct-${list[(index + 1) % list.length].connection.credential_id}`,
  );
});
