import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { config, usage } from "./admin/fixtures.ts";
import { createRuntime } from "../src/platform/standard/runtime.ts";
import { readSettings } from "../src/platform/standard/settings.ts";
import { MemoryRedis } from "../src/platform/standard/redis.ts";
import {
  ObjectRuntime,
  RedisObjectLocks,
  StandardObjectContext,
  BackedObjectStorage,
  AlarmState,
  MemoryObjectBackend,
} from "../src/platform/standard/objects.ts";
import { SqlObjectBackend } from "../src/platform/standard/sql-objects.ts";
import { TaskTracker } from "../src/platform/standard/tasks.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  pgliteQueryable,
  postgresDatabase,
} from "../src/platform/standard/sql/postgres.ts";
import { clearConfigCacheForTests } from "../src/config/store.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const settings = {
  DATABASE_URL: "sqlite::memory:",
  REDIS_URL: "redis://localhost:6379",
  CONFIG_ENCRYPTION_KEY: KEY,
  ADMIN_AUTH_MODE: "token",
  ADMIN_TOKEN: "test-admin-secret",
  CONFIG_CACHE_TTL_SECONDS: "0",
  LOG_LEVEL: "off",
  CRON_SECRET: "test-cron-secret",
};

test("runtime settings enforce platform and authentication requirements", () => {
  const postgres = { ...settings, DATABASE_URL: "postgres://localhost/db" };
  assert.equal(readSettings(postgres, "vercel").DATABASE_MIGRATE, "false");
  assert.equal(readSettings(postgres, "node").DATABASE_MIGRATE, "true");
  assert.throws(
    () => readSettings({ ...postgres, DATABASE_MIGRATE: "true" }, "vercel"),
    /deployment build/,
  );
  assert.throws(() => readSettings(settings, "vercel"), /PostgreSQL/);
  assert.throws(
    () =>
      readSettings(
        { ...settings, ADMIN_AUTH_MODE: "local", HOST: "0.0.0.0" },
        "node",
      ),
    /loopback/,
  );
  assert.throws(
    () => readSettings({ ...settings, ADMIN_AUTH_MODE: "oidc" }, "node"),
    /OIDC/,
  );
  assert.throws(
    () =>
      readSettings({ ...settings, CONFIG_ENCRYPTION_KEY: "secret" }, "node"),
    /32-byte/,
  );
  assert.throws(
    () =>
      readSettings(
        {
          ...settings,
          DATABASE_URL: "postgres://localhost/db",
          CRON_SECRET: undefined,
        },
        "vercel",
      ),
    /CRON_SECRET/,
  );
});

test("Redis renewal and release cannot change a replacement lock", async () => {
  let now = 0;
  const redis = new MemoryRedis(() => now);
  const locks = new RedisObjectLocks(redis, "test");
  const old = await locks.acquire("object");
  now = 30_001;
  const current = await locks.acquire("object");
  await assert.rejects(old.assertHeld(), /lost/);
  await old.release();
  await current.assertHeld();
  assert.equal(
    await redis.expireIfEquals("test:l:object", "wrong-owner", 30_000),
    false,
  );
  await current.release();
});

test("failed object initialization rejects the call", async () => {
  const tasks = new TaskTracker();
  const objects = new ObjectRuntime({
    tasks,
    locks: new RedisObjectLocks(new MemoryRedis()),
  });
  const namespace = objects.namespace(
    "init",
    (ctx) => {
      void ctx.blockConcurrencyWhile(async () => {
        throw new Error("storage unavailable");
      });
      return { read: () => "must not execute" };
    },
    (call) => ({ read: () => call((core) => core.read()) }),
    { backend: new MemoryObjectBackend() },
  );
  await assert.rejects(
    namespace.getByName("one").read(),
    /storage unavailable/,
  );
  await tasks.drain();
});

test("local storage transactions serialize read-modify-write operations", async () => {
  const backend = new MemoryObjectBackend();
  const storage = new BackedObjectStorage(
    backend,
    "test",
    "one",
    new AlarmState(backend, "test", "one"),
  );
  const ctx = new StandardObjectContext(storage);
  await Promise.all(
    Array.from({ length: 20 }, () =>
      ctx.storage.transaction(async (tx) => {
        const value = (await tx.get("count")) ?? 0;
        await Promise.resolve();
        await tx.put("count", value + 1);
      }),
    ),
  );
  assert.equal(await storage.get("count"), 20);
});

test("direct storage operations wait for transactions without losing newer writes", async () => {
  const backend = new MemoryObjectBackend();
  const storage = new BackedObjectStorage(
    backend,
    "test",
    "mixed",
    new AlarmState(backend, "test", "mixed"),
  );
  await storage.put("count", 0);
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const transaction = storage.transaction(async (tx) => {
    const previous = await tx.get("count");
    started.resolve();
    await resume.promise;
    await tx.put("count", previous + 1);
    await tx.setAlarm(100);
  });
  await started.promise;
  const write = storage.put("count", 2);
  const read = storage.get(["count"]);
  const alarm = storage.setAlarm(200);
  assert.equal(await backend.get("test", "mixed", "count"), "0");
  resume.resolve();
  await Promise.all([transaction, write, alarm]);
  assert.equal((await read).get("count"), 2);
  assert.equal(await storage.get("count"), 2);
  assert.equal(await storage.getAlarm(), 200);
  const failed = storage.transaction(async (tx) => {
    await tx.put("count", 99);
    throw new Error("roll back");
  });
  const removed = storage.delete(["count", "count"]);
  await assert.rejects(failed, /roll back/);
  assert.equal(await removed, 1);
  assert.deepEqual(await storage.list(), new Map());
});

test("object acknowledgements precede background delivery while later calls wait for it", async () => {
  const tasks = new TaskTracker();
  const background = Promise.withResolvers();
  let calls = 0;
  let releases = 0;
  const objects = new ObjectRuntime({
    tasks,
    locks: {
      acquire: async () => ({
        assertHeld: async () => {},
        release: async () => {
          if (++releases === 1) throw new Error("release failed");
        },
      }),
    },
  });
  const namespace = objects.namespace(
    "background",
    (ctx) => ({
      run() {
        calls += 1;
        ctx.waitUntil(background.promise);
        return calls;
      },
    }),
    (call) => ({ run: () => call((core) => core.run()) }),
    { backend: new MemoryObjectBackend() },
  );
  const stub = namespace.getByName("one");
  assert.equal(await stub.run(), 1);
  const next = stub.run();
  await Promise.resolve();
  assert.equal(calls, 1);
  background.resolve();
  assert.equal(await next, 2);
  await tasks.drain();
  assert.equal(releases, 2);
});

test("registered object alarms catch up on access and preserve rescheduling", async () => {
  const backend = new MemoryObjectBackend();
  const tasks = new TaskTracker();
  let now = 100;
  let fired = 0;
  const objects = new ObjectRuntime({
    tasks,
    now: () => now,
    locks: new RedisObjectLocks(new MemoryRedis()),
  });
  const namespace = objects.namespace(
    "alarm",
    (ctx) => ({
      start: () => ctx.storage.setAlarm(now),
      read: () => fired,
      async alarm() {
        assert.equal(await ctx.storage.getAlarm(), null);
        fired += 1;
        await ctx.storage.setAlarm(now + 100);
      },
    }),
    (call) => ({
      start: () => call((core) => core.start()),
      read: () => call((core) => core.read()),
    }),
    { backend, alarms: true },
  );
  const stub = namespace.getByName("one");
  await stub.start();
  assert.equal(await stub.read(), 1);
  await tasks.drain();
  assert.equal(await backend.getAlarm("alarm", "one"), 200);
  now = 200;
  assert.equal(await objects.runDueAlarms(), 1);
  await tasks.drain();
  assert.equal(fired, 2);
  assert.equal(await backend.getAlarm("alarm", "one"), 300);
});

for (const dialect of ["sqlite", "postgres"]) {
  test(`${dialect}: standard runtime integration`, async (t) => {
    const pglite = dialect === "postgres" ? new PGlite() : undefined;
    const db = pglite
      ? postgresDatabase(pgliteQueryable(pglite), () => pglite.close())
      : await createSqliteDatabase(":memory:");
    await applyMigrations(db, migrationDirectories(dialect, ROOT));
    const redis = new MemoryRedis();
    const resources = { db, redis, close: async () => {} };
    const runtime = await createRuntime({
      target: "node",
      root: ROOT,
      source: settings,
      resources,
    });
    const second = await createRuntime({
      target: "node",
      root: ROOT,
      source: settings,
      resources,
    });
    t.after(async () => {
      await runtime.close();
      await second.close();
      await db.close();
      clearConfigCacheForTests();
    });
    const env = runtime.bindings;

    await t.test(
      "fences writes made from stale SQL object snapshots",
      async () => {
        const backend = new SqlObjectBackend(db);
        const old = await backend.scope("test", "fence");
        const current = await backend.scope("test", "fence");
        await current.commit("test", "fence", {
          deletes: [],
          puts: [["value", "new"]],
          alarm: 500,
        });
        await assert.rejects(
          old.commit("test", "fence", {
            clear: true,
            deletes: [],
            puts: [["value", "old"]],
            alarm: null,
          }),
          /Stale/,
        );
        assert.equal(await backend.get("test", "fence", "value"), "new");
        assert.equal(await backend.getAlarm("test", "fence"), 500);
      },
    );

    await t.test(
      "migration failures roll back schema and history together",
      async () => {
        await assert.rejects(
          db.applyMigration(
            "CREATE TABLE migration_test (id INTEGER); INSERT INTO missing_table VALUES (1);",
            "failed.sql",
          ),
        );
        await assert.rejects(db.prepare("SELECT * FROM migration_test").all());
        assert.equal(
          await db
            .prepare("SELECT name FROM schema_migrations WHERE name = ?")
            .bind("failed.sql")
            .first(),
          null,
        );
      },
    );

    await t.test(
      "publishes configuration and protects administrator APIs",
      async () => {
        const unauthorized = await runtime.fetch(
          new Request("http://localhost/console/api/config"),
        );
        assert.equal(unauthorized.status, 401);
        const publisher = env.CONFIG_PUBLISHER.getByName("configuration");
        assert.equal(
          JSON.parse(
            await publisher.saveDraft(JSON.stringify(config()), 0, "tester"),
          ).ok,
          true,
        );
        assert.equal(JSON.parse(await publisher.publish(1, "tester")).ok, true);
        const authenticated = await runtime.fetch(
          new Request("http://localhost/console/api/config", {
            headers: { authorization: "Bearer test-admin-secret" },
          }),
        );
        assert.equal(authenticated.status, 200);
        assert.equal((await authenticated.json()).published_revision, 1);
        const unsafe = await runtime.fetch(
          new Request("http://localhost/console/api/config", {
            method: "PUT",
            headers: {
              authorization: "Bearer test-admin-secret",
              "content-type": "application/json",
            },
            body: "{}",
          }),
        );
        assert.equal(unsafe.status, 403);
        assert.equal(
          (
            await runtime.fetch(
              new Request("http://localhost/console/auth/login"),
            )
          ).status,
          404,
        );
      },
    );

    await t.test(
      "concurrent health updates persist across runtime instances",
      async () => {
        await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            (index % 2 ? env : second.bindings).HEALTH.getByName(
              "health-test",
            ).recordFailure(),
          ),
        );
        const status =
          await second.bindings.HEALTH.getByName("health-test").getStatus();
        assert.equal(status.failures, 10);
        assert.ok(status.cooling_until > Date.now());
        await env.HEALTH.getByName("health-test").recordSuccess();
        assert.equal(
          (await second.bindings.HEALTH.getByName("health-test").getStatus())
            .cooling_until,
          null,
        );
      },
    );

    await t.test(
      "affinity, ownership and session index survive a new runtime",
      async () => {
        const registration = {
          registry_name: "a".repeat(64),
          session_digest: "b".repeat(64),
          session_id: "shared-session",
        };
        const name = `${registration.registry_name}:${registration.session_digest}`;
        const candidates = [
          {
            provider_id: "provider",
            priority: 1,
            credentials: [{ credential_id: "primary", priority: 1 }],
          },
        ];
        const first = await env.SESSION_AFFINITY.getByName(name).resolve(
          candidates,
          undefined,
          registration,
        );
        await runtime.tasks.drain();
        const next = await second.bindings.SESSION_AFFINITY.getByName(
          name,
        ).resolve(candidates, undefined, registration);
        assert.equal(next.status, "hit");
        assert.equal(next.binding_id, first.binding_id);
        assert.equal(
          (
            await env.SESSION_AFFINITY_INDEX.getByName(
              registration.registry_name,
            ).listPage(null, 10)
          ).data[0].session_id,
          "shared-session",
        );
        const ownerName = "context-owner:" + registration.session_digest;
        assert.equal(
          await env.SESSION_AFFINITY.getByName(ownerName).claimContextSession(
            "client-a",
          ),
          true,
        );
        const restarted = await createRuntime({
          target: "node",
          root: ROOT,
          source: settings,
          resources: { ...resources, redis: new MemoryRedis() },
        });
        assert.equal(
          await restarted.bindings.SESSION_AFFINITY.getByName(
            ownerName,
          ).claimContextSession("client-b"),
          false,
        );
        assert.equal(
          await restarted.bindings.SESSION_AFFINITY.getByName(
            ownerName,
          ).releaseContextSession("client-b"),
          "forbidden",
        );
        await restarted.close();
        assert.equal(
          await env.SESSION_AFFINITY.getByName(name).clearIfBindingId(
            "wrong",
            first.generation,
          ),
          false,
        );
        assert.equal(
          await env.SESSION_AFFINITY.getByName(name).clearIfBindingId(
            first.binding_id,
            first.generation,
          ),
          true,
        );
        await runtime.tasks.drain();
      },
    );

    await t.test(
      "proxy cooldowns retain sticky bindings and fence late outcomes",
      async () => {
        const group = {
          id: "proxies",
          revision: 1,
          strategy: "sticky",
          proxies: ["a", "b"].map((id, i) => ({
            id,
            fingerprint: String(i).repeat(64),
            priority: i,
            disabled: false,
          })),
        };
        const input = {
          group,
          owner: { provider_id: "provider" },
          exclude: [],
        };
        const stub = env.PROXY_GROUP.getByName(group.id);
        const first = await stub.select(input);
        assert.deepEqual(
          await second.bindings.PROXY_GROUP.getByName(group.id).select(input),
          first,
        );
        for (let i = 0; i < 3; i++)
          await stub.observe({
            lease: first.lease,
            event_id: crypto.randomUUID(),
            observed_at: Date.now(),
            outcome: "failure",
          });
        const next = await stub.select(input);
        assert.notEqual(next.lease.proxy_id, first.lease.proxy_id);
        await stub.observe({
          lease: first.lease,
          event_id: crypto.randomUUID(),
          observed_at: Date.now(),
          outcome: "success",
        });
        assert.equal(
          (await stub.getStatus(group)).proxies.find(
            (p) => p.id === first.lease.proxy_id,
          ).status,
          "cooling",
        );
        await stub.clear(group, first.lease.proxy_id);
        assert.equal(
          (await stub.select(input)).lease.proxy_id,
          next.lease.proxy_id,
        );
      },
    );

    await t.test("usage delivery is durable and idempotent", async () => {
      const event = usage("runtime-usage", Date.now());
      await env.USAGE_OUTBOX.getByName("ru").enqueue(event);
      await runtime.tasks.drain();
      await second.bindings.USAGE_OUTBOX.getByName("ru").enqueue(event);
      await second.tasks.drain();
      const result = await db
        .prepare("SELECT COUNT(*) AS count FROM requests WHERE request_id = ?")
        .bind(event.request_id)
        .first();
      assert.equal(Number(result.count), 1);
    });

    await t.test(
      "Vercel rejects WebSocket upgrades and authenticates maintenance",
      async () => {
        const vercel = await createRuntime({
          target: "vercel",
          root: ROOT,
          source: { ...settings, DATABASE_URL: "postgres://localhost/cody" },
          resources,
        });
        const response = await vercel.fetch(
          new Request("https://cody.test/v1/responses", {
            headers: {
              authorization: "Bearer test-client-secret",
              upgrade: "websocket",
            },
          }),
        );
        assert.equal(response.status, 501);
        assert.equal(
          (await response.json()).error.code,
          "websocket_unsupported",
        );
        assert.equal(
          (
            await vercel.fetch(
              new Request("https://cody.test/_cody/maintenance"),
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await vercel.fetch(
              new Request("https://cody.test/_cody/maintenance", {
                headers: { authorization: "Bearer test-cron-secret" },
              }),
            )
          ).status,
          200,
        );
        await vercel.close();
      },
    );
  });
}
