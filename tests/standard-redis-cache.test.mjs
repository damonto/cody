import assert from "node:assert/strict";
import { test } from "node:test";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import { MemoryRedis } from "../src/platform/standard/redis.ts";
import { createRuntime } from "../src/platform/standard/runtime.ts";
import { SqlObjectBackend } from "../src/platform/standard/sql-objects.ts";
import { CachedSqlObjectBackend } from "../src/platform/standard/cached-objects.ts";
import { AccountDecodeCache } from "../src/platform/standard/account-cache.ts";
import { encryptConfig } from "../src/control/crypto.ts";
import { storedSchema, emptyQuota } from "../src/providers/oauth/state.ts";
import { connectRedis } from "../src/platform/standard/ioredis.ts";
import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@libsql/client";
import { libsqlDatabase } from "../src/platform/standard/sql/libsql.ts";
import {
  postgresDatabase,
  pgliteQueryable,
} from "../src/platform/standard/sql/postgres.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async function fixture(
  t,
  redis = new MemoryRedis(),
  openDatabase = () => createSqliteDatabase(":memory:"),
) {
  const raw = await openDatabase();
  await applyMigrations(raw, migrationDirectories(raw.dialect, ROOT));
  const queries = [];
  const db = {
    ...raw,
    prepare(query) {
      queries.push(query);
      return raw.prepare(query);
    },
  };
  const runtimes = [];
  async function open(nextRedis = redis) {
    const runtime = await createRuntime({
      target: "node",
      root: ROOT,
      source: {
        DATABASE_URL: "sqlite::memory:",
        REDIS_URL: "redis://localhost:6379",
        CONFIG_ENCRYPTION_KEY: KEY,
        ADMIN_AUTH_MODE: "token",
        ADMIN_TOKEN: "test-admin-secret",
        LOG_LEVEL: "off",
      },
      resources: { db, redis: nextRedis, close: async () => {} },
    });
    runtimes.push(runtime);
    return runtime;
  }
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await raw.close();
  });
  return { raw, db, redis, queries, open, sql: new SqlObjectBackend(raw) };
}

const registration = {
  model: "model-a",
  registry_name: "a".repeat(64),
  session_digest: "b".repeat(64),
  session_id: "session-a",
};
const candidates = [
  {
    provider_id: "provider-a",
    priority: 1,
    credentials: [{ credential_id: "credential-a", priority: 1 }],
  },
];

test("warm health and affinity read Redis across instances without SQL reads", async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const second = await f.open();
  await first.bindings.HEALTH.getByName("health-a").getStatus();
  await first.tasks.drain();
  f.queries.length = 0;
  await second.bindings.HEALTH.getByName("health-a").getStatus();
  await second.bindings.HEALTH.getByName("health-a").recordSuccess();
  await second.tasks.drain();
  assert.equal(f.queries.length, 0);
  await first.bindings.SESSION_AFFINITY.getByName("session-a").resolve(
    candidates,
    undefined,
    registration,
  );
  await first.tasks.drain();
  f.queries.length = 0;
  const hit = await second.bindings.SESSION_AFFINITY.getByName(
    "session-a",
  ).resolve(candidates, undefined, registration);
  await second.tasks.drain();
  assert.equal(hit.status, "hit");
  assert.equal(
    f.queries.filter((query) => query.startsWith("SELECT")).length,
    0,
  );
  assert.ok(
    f.queries.some((query) => query.startsWith("UPDATE object_versions")),
  );
  assert.equal(f.queries.length, 3);
});

test("SQL health state survives Redis loss", async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  await first.bindings.HEALTH.getByName("cooldown").recordCooldownUntil(
    Date.now() + 600_000,
    "quota",
  );
  await first.tasks.drain();
  const recovered = await f.open(new MemoryRedis());
  assert.ok(
    (await recovered.bindings.HEALTH.getByName("cooldown").getStatus())
      .cooling_until > Date.now(),
  );
});

test("warm OAuth readiness avoids SQL and repeated decryption but observes disconnects", async (t) => {
  const f = await fixture(t);
  const accountRef = crypto.randomUUID();
  const stored = storedSchema.parse({
    account_ref: accountRef,
    provider_id: "provider",
    provider_type: "codex",
    generation: 1,
    status: "ready",
    connection: { provider_id: "provider", credential_id: "credential" },
    tokens: {
      access_token: "test-access-token",
      expires_at: Date.now() + 600_000,
    },
    identity: null,
    codex: {
      account_id: "test-account",
      user_id: null,
      plan_type: null,
      subscription_active_until: null,
    },
    project_id: null,
    error: null,
    session: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: emptyQuota(),
  });
  const encrypted = await encryptConfig(stored, KEY);
  const sql = await f.sql.scope("oauth", accountRef);
  await sql.commit("oauth", accountRef, {
    puts: [["account", JSON.stringify(encrypted)]],
    deletes: [],
  });
  const runtime = await f.open();
  const writer = await f.open();
  const account = runtime.bindings.PROVIDER_OAUTH_ACCOUNT.getByName(accountRef);
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let decryptions = 0;
  t.mock.method(crypto.subtle, "decrypt", (...args) => {
    decryptions++;
    return decrypt(...args);
  });
  assert.deepEqual(await account.run({ action: "readiness" }), {
    ok: true,
    data: { ready: true },
  });
  const initial = decryptions;
  assert.ok(initial > 0);
  await runtime.tasks.drain();
  f.queries.length = 0;
  assert.deepEqual(await account.run({ action: "readiness" }), {
    ok: true,
    data: { ready: true },
  });
  assert.equal(decryptions, initial);
  assert.equal(f.queries.length, 0);
  assert.equal(
    (
      await writer.bindings.PROVIDER_OAUTH_ACCOUNT.getByName(accountRef).run({
        action: "disconnect",
      })
    ).ok,
    true,
  );
  assert.deepEqual(await account.run({ action: "readiness" }), {
    ok: true,
    data: { ready: false },
  });
});

test("warm proxy selection and rotation use Redis while persisting selection changes", async (t) => {
  const f = await fixture(t);
  const runtime = await f.open();
  const group = {
    id: "proxy",
    revision: 1,
    strategy: "sticky",
    proxies: [
      { id: "node", fingerprint: "0".repeat(64), priority: 1, disabled: false },
    ],
  };
  const input = { group, owner: { provider_id: "provider" }, exclude: [] };
  const proxy = runtime.bindings.PROXY_GROUP.getByName(group.id);
  const first = await proxy.select(input);
  await runtime.tasks.drain();
  f.queries.length = 0;
  assert.deepEqual(await proxy.select(input), first);
  assert.equal(f.queries.length, 0);
  const rotation = runtime.bindings.HEALTH.getByName("rotation:provider");
  assert.equal(await rotation.rotate(["a", "b"], true), "a");
  await runtime.tasks.drain();
  f.queries.length = 0;
  assert.equal(await rotation.rotate(["a", "b"], true), "b");
  assert.equal(
    f.queries.filter((query) => query.startsWith("SELECT")).length,
    0,
  );
  assert.equal(f.queries.length, 2);
});

test("a failed Redis publication recovers the committed SQL state", async (t) => {
  const redis = new MemoryRedis();
  const f = await fixture(t, redis);
  const runtime = await f.open();
  const health = runtime.bindings.HEALTH.getByName("failure");
  await health.getStatus();
  await runtime.tasks.drain();
  const original = redis.compareAndWrite.bind(redis);
  let fail = true;
  redis.compareAndWrite = async (conditions, commands) => {
    if (fail && conditions.some(({ value }) => value?.startsWith("writing:"))) {
      fail = false;
      throw new Error("publication unavailable");
    }
    return original(conditions, commands);
  };
  await assert.rejects(health.recordFailure(), /publication unavailable/);
  assert.equal((await health.getStatus()).failures, 1);
  await runtime.tasks.drain();
  f.queries.length = 0;
  assert.equal((await health.getStatus()).failures, 1);
  assert.equal(f.queries.length, 0);
});

test("SQL recovery fences a delayed writer after its Redis lease expires", async (t) => {
  let now = Date.now();
  const redis = new MemoryRedis(() => now);
  const f = await fixture(t, redis);
  const first = await f.open();
  const second = await f.open();
  const a = first.bindings.HEALTH.getByName("delayed");
  await a.getStatus();
  await first.tasks.drain();
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let block = true;
  f.db.batch = async (statements) => {
    if (
      block &&
      statements.some((statement) =>
        statement.sql.startsWith("INSERT INTO object_storage"),
      )
    ) {
      block = false;
      paused.resolve();
      await resume.promise;
    }
    return f.raw.batch(statements);
  };
  const late = a.recordFailure();
  const rejected = assert.rejects(late, /Stale object storage/);
  await paused.promise;
  now += 60_001;
  assert.equal(
    (await second.bindings.HEALTH.getByName("delayed").getStatus()).failures,
    0,
  );
  resume.resolve();
  await rejected;
  await first.tasks.drain();
  await second.tasks.drain();
  assert.equal(
    (await second.bindings.HEALTH.getByName("delayed").getStatus()).failures,
    0,
  );
});

test("cached bounded index pages are invalidated when deletion exposes the next entry", async (t) => {
  const f = await fixture(t);
  const runtime = await f.open();
  const index = runtime.bindings.SESSION_AFFINITY_INDEX.getByName("index");
  for (const digit of ["1", "2", "3"])
    await index.register({
      ...registration,
      session_digest: digit.repeat(64),
      binding_id: digit,
      created_at: 1,
      generation: 1,
    });
  await index.listPage(null, 1);
  await runtime.tasks.drain();
  f.queries.length = 0;
  assert.equal((await index.listPage(null, 1)).data[0].binding_id, "1");
  assert.equal(f.queries.length, 0);
  await index.remove("1".repeat(64), "1", 1);
  assert.equal((await index.listPage(null, 1)).data[0].binding_id, "2");
});

test("xAI replay lives entirely in Redis and fences superseded turns", async (t) => {
  const f = await fixture(t);
  const runtime = await f.open();
  const replay = runtime.bindings.SESSION_AFFINITY.getByName("xai-replay:a");
  f.queries.length = 0;
  const first = await replay.beginXaiReplay();
  assert.equal(
    await replay.commitXaiReplay(first.version, "encrypted-history"),
    true,
  );
  const second = await replay.beginXaiReplay();
  assert.equal(second.value, "encrypted-history");
  assert.equal(await replay.commitXaiReplay(first.version, "obsolete"), false);
  assert.equal(
    await replay.commitXaiReplay(second.version, "new-history"),
    true,
  );
  await runtime.tasks.drain();
  assert.equal(f.queries.length, 0);
});

test("Redis replay expires without SQL recovery and rejects expired turns", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const f = await fixture(t);
  const first = await f.open();
  const second = await f.open();
  const name = "xai-replay:expiring";
  const replay = first.bindings.SESSION_AFFINITY.getByName(name);
  f.queries.length = 0;
  const turn = await replay.beginXaiReplay();
  assert.equal(await replay.commitXaiReplay(turn.version, "ciphertext"), true);
  await first.tasks.drain();
  assert.ok(await f.redis.hlen(`cody:o:affinity:${name}`));
  t.mock.timers.setTime(now + 3_600_001);
  assert.equal(await f.redis.hlen(`cody:o:affinity:${name}`), 0);
  assert.equal(await replay.commitXaiReplay(turn.version, "obsolete"), false);
  const fresh =
    await second.bindings.SESSION_AFFINITY.getByName(name).beginXaiReplay();
  assert.equal(fresh.value, null);
  assert.notEqual(fresh.version, turn.version);
  await first.tasks.drain();
  await second.tasks.drain();
  assert.equal(f.queries.length, 0);
  assert.deepEqual(await f.sql.list("affinity", name, {}), []);
});

for (const [dialect, openDatabase] of Object.entries({
  sqlite: () => createSqliteDatabase(":memory:"),
  libsql: () => libsqlDatabase(createClient({ url: ":memory:" })),
  postgres: () => {
    const pg = new PGlite();
    return postgresDatabase(pgliteQueryable(pg), () => pg.close());
  },
})) {
  test(`${dialect}: Redis replay never restores SQL-only rows or schedules their alarms`, async (t) => {
    const f = await fixture(t, new MemoryRedis(), openDatabase);
    const name = "xai-replay:sql-only";
    const sql = await f.sql.scope("affinity", name);
    const entries = [
      [
        "xai_replay",
        JSON.stringify({
          version: crypto.randomUUID(),
          expires: Date.now() + 600_000,
          chunks: 1,
        }),
      ],
      ["xai_replay:0", JSON.stringify("sql-only-ciphertext")],
    ];
    await sql.commit("affinity", name, {
      puts: entries,
      deletes: [],
      alarm: Date.now() - 1000,
    });
    const durable = await f.sql.scope("affinity", "durable");
    await durable.commit("affinity", "durable", {
      puts: [],
      deletes: [],
      alarm: Date.now() - 1,
    });
    const runtime = await f.open();
    f.queries.length = 0;
    assert.equal(
      (await runtime.bindings.SESSION_AFFINITY.getByName(name).beginXaiReplay())
        .value,
      null,
    );
    await runtime.tasks.drain();
    assert.equal(f.queries.length, 0);
    const backend = new CachedSqlObjectBackend(f.raw, f.redis);
    assert.deepEqual(await backend.dueAlarms("affinity", Date.now(), 1), [
      "durable",
    ]);
    assert.deepEqual(await f.sql.list("affinity", name, {}), entries);
  });

  test(`${dialect}: Redis eviction preserves durable health and session bindings`, async (t) => {
    const f = await fixture(t, new MemoryRedis(), openDatabase);
    const first = await f.open();
    const managed = candidates.map((candidate) => ({
      ...candidate,
    }));
    await first.bindings.HEALTH.getByName("portable").recordFailure();
    const binding = await first.bindings.SESSION_AFFINITY.getByName(
      "portable",
    ).resolve(managed, undefined, registration);
    await first.tasks.drain();
    const freshRedis = new MemoryRedis();
    const recovered = await f.open(freshRedis);
    assert.equal(
      (await recovered.bindings.HEALTH.getByName("portable").getStatus())
        .failures,
      1,
    );
    const pin = await recovered.bindings.SESSION_AFFINITY.getByName(
      "portable",
    ).resolve(managed, undefined, registration);
    assert.equal(pin.binding_id, binding.binding_id);
    assert.equal(pin.model, registration.model);
    await recovered.tasks.drain();
    const reader = await f.open(freshRedis);
    f.queries.length = 0;
    assert.equal(
      (await reader.bindings.HEALTH.getByName("portable").getStatus()).failures,
      1,
    );
    assert.equal(
      (
        await reader.bindings.SESSION_AFFINITY.getByName("portable").getStatus(
          registration.session_digest,
        )
      ).binding_id,
      binding.binding_id,
    );
    await reader.tasks.drain();
    assert.equal(f.queries.length, 0);
  });
}

test("account decode cache validates ciphertext and never shares mutable snapshots", async () => {
  const cache = new AccountDecodeCache(KEY);
  const account = storedSchema.parse({
    account_ref: crypto.randomUUID(),
    provider_id: "provider",
    provider_type: "codex",
    generation: 1,
    status: "disconnected",
    connection: { provider_id: "provider", credential_id: "credential" },
    tokens: null,
    identity: null,
    project_id: null,
    error: null,
    session: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: emptyQuota(),
  });
  const encrypted = await encryptConfig(account, KEY);
  const first = await cache.load(encrypted);
  first.generation = 999;
  assert.equal((await cache.load(encrypted)).generation, 1);
  const replacement = await encryptConfig({ ...account, generation: 2 }, KEY);
  assert.equal((await cache.load(replacement)).generation, 2);
  // Invalid decrypted accounts must never enter the cache, including on retry.
  const invalid = await encryptConfig({ provider_type: "unknown" }, KEY);
  await assert.rejects(cache.load(invalid));
  await assert.rejects(cache.load(invalid));
  cache.clear();
});

test(
  "real Redis executes guarded cache and replay operations",
  { skip: !process.env.CODY_TEST_REDIS_SOCKET },
  async (t) => {
    const redis = await connectRedis(process.env.CODY_TEST_REDIS_SOCKET);
    const f = await fixture(t, redis);
    t.after(() => redis.quit());
    const runtime = await f.open();
    const id = crypto.randomUUID();
    const health = runtime.bindings.HEALTH.getByName(id);
    await health.recordFailure();
    await runtime.tasks.drain();
    f.queries.length = 0;
    assert.equal((await health.getStatus()).failures, 1);
    assert.equal(f.queries.length, 0);
    await Promise.all(Array.from({ length: 9 }, () => health.recordFailure()));
    assert.ok((await health.getStatus()).cooling_until > Date.now());
    const name = `xai-replay:${id}`;
    const replay = runtime.bindings.SESSION_AFFINITY.getByName(name);
    f.queries.length = 0;
    const turn = await replay.beginXaiReplay();
    assert.equal(
      await replay.commitXaiReplay(turn.version, "ciphertext"),
      true,
    );
    assert.equal(
      (await runtime.bindings.SESSION_AFFINITY.getByName(name).beginXaiReplay())
        .value,
      "ciphertext",
    );
    assert.equal(f.queries.length, 0);
    assert.equal(
      await redis.compareAndWrite(
        [{ key: `missing:${id}`, value: "owner" }],
        [["set", `unwritten:${id}`, "bad"]],
      ),
      false,
    );
    assert.equal(await redis.get(`unwritten:${id}`), null);

    // Redis scripts isolate execution but do not roll back earlier commands
    // when HSET fails. The dirty marker must survive a partial publication.
    const compareAndWrite = redis.compareAndWrite.bind(redis);
    let corruptPublication = true;
    redis.compareAndWrite = async (conditions, commands) => {
      const writing = conditions.some(({ value }) =>
        value?.startsWith("writing:"),
      );
      const entry = commands.find(([command]) => command === "hset");
      if (corruptPublication && writing && entry) {
        corruptPublication = false;
        await redis.set(entry[1], "wrong-type", { px: 1000 });
      }
      return compareAndWrite(conditions, commands);
    };
    const failed = runtime.bindings.HEALTH.getByName(`partial:${id}`);
    await assert.rejects(failed.recordFailure(), /WRONGTYPE/);
    assert.equal((await failed.getStatus()).failures, 1);
  },
);
