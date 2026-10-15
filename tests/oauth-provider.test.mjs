import assert from "node:assert/strict";
import test from "node:test";
import { accountProvider } from "../src/providers/oauth/registry.ts";
import { AccountInventory } from "../src/providers/oauth/inventory.ts";
import { storedSchema } from "../src/providers/oauth/state.ts";
import { OAuthError } from "../src/providers/oauth/schema.ts";
import { ProviderOAuthAccountCore } from "../src/providers/oauth/account.ts";
import { decryptConfig, encryptConfig } from "../src/control/crypto.ts";

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
