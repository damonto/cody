import { siwcHostId } from "../src/providers/codex/siwc-host.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  d1DatabaseTransfer,
  loadSqliteDump,
  writeD1Import,
} from "../scripts/transfer-database.mjs";
import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@libsql/client";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  postgresDatabase,
  pgliteQueryable,
} from "../src/platform/standard/sql/postgres.ts";
import { libsqlDatabase } from "../src/platform/standard/sql/libsql.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import { TransferService } from "../src/transfer/service.ts";
import { standardTransferObjects } from "../src/transfer/standard.ts";
import {
  transferInstances,
  newState,
  abortTransfer,
} from "../src/transfer/runner.ts";
import { commandSchema } from "../src/transfer/protocol.ts";
import { validateSnapshotReferences } from "../src/transfer/references.ts";
import { ControlStore } from "../src/control/store.ts";
import { ingestUsage, cleanupRequests } from "../src/reporting/store.ts";
import { config, usage } from "./admin/fixtures.ts";
import { seedTransferAccounts } from "./helpers/transfer-fixture.ts";
import {
  AlarmState,
  BackedObjectStorage,
} from "../src/platform/standard/objects.ts";
import { SqlObjectBackend } from "../src/platform/standard/sql-objects.ts";
import { decryptConfig, encryptConfig } from "../src/control/crypto.ts";
import { ProviderOAuthAccountCore } from "../src/providers/oauth/account.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const factories = {
  sqlite: (path = ":memory:") => createSqliteDatabase(path),
  postgres: async () => postgresDatabase(pgliteQueryable(new PGlite())),
  libsql: async () => libsqlDatabase(createClient({ url: ":memory:" })),
};
async function instance(kind = "sqlite", key = KEY, path) {
  const db = await factories[kind](path);
  await applyMigrations(db, migrationDirectories(db.dialect, ROOT));
  const env = { CODY_DB: db, CONFIG_ENCRYPTION_KEY: key };
  const objects = standardTransferObjects(db);
  const backend = new SqlObjectBackend(db);
  const storage = (ref) =>
    new BackedObjectStorage(
      backend,
      ref.kind,
      ref.name,
      new AlarmState(backend, ref.kind, ref.name),
    );
  const service = new TransferService(env, objects, "standard");
  return {
    db,
    env,
    objects,
    storage,
    call: (command) => service.execute(commandSchema.parse(command)),
  };
}
async function preflight(source, target) {
  const command = { action: "preflight", challenge: crypto.randomUUID() };
  const [sourceInfo, targetInfo] = await Promise.all([
    source.call(command),
    target.call(command),
  ]);
  assert.equal(sourceInfo.schema, targetInfo.schema);
  assert.equal(sourceInfo.key_proof, targetInfo.key_proof);
  assert.equal(targetInfo.empty, true);
  return { sourceInfo, targetInfo };
}
async function seed(source) {
  await new ControlStore(source.db, KEY).save(config(), 0, "transfer-test");
  const changed = config();
  changed.providers[0].credentials[0].auth.api_key = "rotated-mock-key";
  await new ControlStore(source.db, KEY).save(changed, 1, "transfer-test");
  return seedTransferAccounts(source.db, KEY, async (ref, entries) => {
    for (const [key, value] of entries)
      await source.storage(ref).put(key, value);
  });
}
async function seedUsage(source) {
  const historic = usage("retained-aggregate", 1_700_000_000_000);
  await ingestUsage(source.db, historic);
  await cleanupRequests(source.db, 0);
  for (let i = 0; i < 55; i++)
    await ingestUsage(source.db, usage(`current-${i}`, Date.now()));
  await source.db
    .prepare(
      "UPDATE usage_hourly SET input_tokens = CAST(? AS BIGINT) WHERE hour < ?",
    )
    .bind("9007199254740993", Date.now() - 3600000)
    .run();
}
for (const [from, to] of [
  ["sqlite", "postgres"],
  ["postgres", "sqlite"],
  ["sqlite", "libsql"],
  ["libsql", "sqlite"],
]) {
  test(`complete transfer ${from} -> ${to}: retained rollups, pages, ciphertext and durable identities`, async () => {
    const source = await instance(from),
      target = await instance(to);
    try {
      const sourceHost = await siwcHostId(source.db);
      const targetHost = await siwcHostId(target.db);
      const accounts = await seed(source);
      await seedUsage(source);
      const info = await preflight(source, target);
      const journal = {
        state: newState(
          crypto.randomUUID(),
          "source",
          "target",
          info.sourceInfo.schema,
        ),
        save: async () => {},
      };
      await transferInstances(source, target, journal);
      assert.equal(await siwcHostId(target.db), targetHost);
      assert.notEqual(targetHost, sourceHost);
      for (const table of [
        "providers",
        "secret_versions",
        "config_snapshots",
        "model_price_versions",
        "audit_log",
        "requests",
        "request_attempts",
        "usage_hourly",
      ]) {
        const cols =
          table === "usage_hourly"
            ? "hour, CAST(input_tokens AS TEXT) AS input_tokens, requests_count"
            : "*";
        assert.deepEqual(
          (
            await target.db
              .prepare(`SELECT ${cols} FROM ${table} ORDER BY 1`)
              .all()
          ).results,
          (
            await source.db
              .prepare(`SELECT ${cols} FROM ${table} ORDER BY 1`)
              .all()
          ).results,
          table,
        );
      }
      assert.equal(
        (await source.db.prepare("SELECT maintenance FROM config_meta").first())
          .maintenance,
        0,
      );
      assert.equal(
        (await target.db.prepare("SELECT maintenance FROM config_meta").first())
          .maintenance,
        0,
      );
      assert.equal(
        (await new ControlStore(target.db, KEY).current()).providers.length,
        (await new ControlStore(source.db, KEY).revision(1)).providers.length,
      );
      for (const fixture of accounts) {
        const storage = target.storage(fixture.object);
        assert.equal(await storage.get("account"), fixture.ciphertext);
        assert.deepEqual(
          await decryptConfig(await storage.get("account"), KEY),
          fixture.account,
        );
        assert.equal(
          await target.storage(fixture.health).get("health"),
          undefined,
        );
        assert.equal(
          await target.storage(fixture.health).get("lease:reset"),
          undefined,
        );
        const initializing = [],
          background = [];
        const ctx = {
          storage,
          blockConcurrencyWhile: (fn) => {
            const task = fn();
            initializing.push(task);
            return task;
          },
          waitUntil: (task) => background.push(task),
        };
        const core = new ProviderOAuthAccountCore(ctx, {
          ...target.env,
          LOG_LEVEL: "silent",
        });
        await Promise.all(initializing);
        let refreshes = 0;
        core.outbound = async () => [
          async (request) => {
            if (request.url.endsWith("/.well-known/openid-configuration"))
              return Response.json({
                device_authorization_endpoint: "https://auth.x.ai/device",
                token_endpoint: "https://auth.x.ai/token",
              });
            assert.equal(request.method, "POST");
            const grant = request.headers
              .get("content-type")
              .includes("application/json")
              ? await request.json()
              : Object.fromEntries(new URLSearchParams(await request.text()));
            assert.equal(grant.grant_type, "refresh_token");
            assert.equal(grant.refresh_token, "mock-refresh");
            refreshes++;
            return Response.json({
              access_token: "mock-rotated",
              refresh_token: "mock-rotated-refresh",
              expires_in: 3600,
              ...(fixture.account.provider_type === "xai"
                ? {
                    id_token: `e30.${Buffer.from(JSON.stringify({ sub: "mock-subject" })).toString("base64url")}.mock`,
                  }
                : {}),
            });
          },
          new AbortController().signal,
        ];
        assert.equal((await core.resolve()).token, "mock-rotated");
        assert.equal(refreshes, 1);
        await Promise.all(background);
        const after = await decryptConfig(await storage.get("account"), KEY);
        assert.equal(after.generation, fixture.account.generation);
        assert.equal(after.tokens.refresh_token, "mock-rotated-refresh");
      }
      await assert.rejects(abortTransfer(source, target, journal), /enabled/);
    } finally {
      await source.db.close();
      await target.db.close();
    }
  });
}
test("read-only preflight rejects nonempty targets and detects keys/schema without writes", async () => {
  const source = await instance(),
    target = await instance("sqlite", Buffer.alloc(32, 1).toString("base64"));
  try {
    const before = (await target.db.prepare("SELECT * FROM config_meta").all())
      .results;
    const challenge = crypto.randomUUID();
    const a = await source.call({ action: "preflight", challenge }),
      b = await target.call({ action: "preflight", challenge });
    assert.notEqual(a.key_proof, b.key_proof);
    assert.deepEqual(
      (await target.db.prepare("SELECT * FROM config_meta").all()).results,
      before,
    );
    await seedUsage(target);
    assert.equal(
      (await target.call({ action: "preflight", challenge })).empty,
      false,
    );
    await assert.rejects(target.call({ action: "prepare" }), /business data/);
    await source.db.exec("CREATE TABLE unknown_data (id TEXT)");
    await assert.rejects(
      source.call({ action: "preflight", challenge }),
      /schema/,
    );
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("preflight propagates object storage failures instead of reporting a nonempty target", async () => {
  const target = await instance();
  try {
    const service = new TransferService(
      target.env,
      {
        ...target.objects,
        empty: async () => {
          throw new Error("Object SQL unavailable");
        },
      },
      "standard",
    );
    await assert.rejects(
      service.execute({ action: "preflight", challenge: crypto.randomUUID() }),
      /preflight: persistent object storage: Storage or runtime operation failed/,
    );
  } finally {
    target.db.close();
  }
});

for (const reference of ["secret", "oauth", "price"])
  test(`transfer rejects a missing historical ${reference} reference before activation`, async () => {
    const source = await instance(),
      target = await instance();
    const journal = {
      state: newState(crypto.randomUUID(), "source", "target", "schema"),
      save: async () => {},
    };
    try {
      await seed(source);
      const row = await source.db
        .prepare("SELECT config_json FROM config_snapshots WHERE version = 1")
        .first();
      const snapshot = JSON.parse(row.config_json);
      const missing = crypto.randomUUID();
      if (reference === "secret")
        snapshot.api_keys[0].api_key = `__cody_secret:${missing}`;
      else if (reference === "oauth")
        snapshot.providers[0].credentials[0].auth = {
          type: "oauth",
          account_ref: missing,
        };
      else snapshot.model_prices[0].version_id = missing;
      await source.db
        .prepare(
          "UPDATE config_snapshots SET config_json = ? WHERE version = 1",
        )
        .bind(JSON.stringify(snapshot))
        .run();
      await assert.rejects(
        transferInstances(source, target, journal),
        /Configuration snapshot references missing/,
      );
      assert.notEqual(journal.state.phase, "activating");
      assert.notEqual(journal.state.phase, "completed");
      assert.equal(
        (
          await target.db
            .prepare("SELECT COUNT(*) AS count FROM object_alarms")
            .first()
        ).count,
        0,
      );
    } finally {
      source.db.close();
      target.db.close();
    }
  });

test("transfer rejects decryptable secrets that are not credential strings", async () => {
  const source = await instance();
  try {
    await seed(source);
    await source.db
      .prepare("UPDATE secret_versions SET ciphertext = ?")
      .bind(await encryptConfig({ invalid: "not a credential" }, KEY))
      .run();
    await assert.rejects(
      source.call({ action: "read", table: "secret_versions", cursor: null }),
      /Data does not match the transfer schema/,
    );
  } finally {
    source.db.close();
  }
});

test("SQLite statistics are not business data and broken foreign keys fail validation", async () => {
  const source = await instance();
  try {
    await seed(source);
    await source.db.exec("ANALYZE");
    await source.call({ action: "preflight", challenge: crypto.randomUUID() });
    await source.db.exec("PRAGMA foreign_keys = OFF");
    await source.db
      .prepare("UPDATE clients SET secret_id = ?")
      .bind(crypto.randomUUID())
      .run();
    await source.db.exec("PRAGMA foreign_keys = ON");
    await assert.rejects(source.call({ action: "validate" }), /Foreign key/);
  } finally {
    source.db.close();
  }
});

test("lost SQL/object acknowledgements resume from local intents without duplication", async () => {
  const source = await instance(),
    target = await instance();
  try {
    await seed(source);
    await seedUsage(source);
    const info = await preflight(source, target);
    const journal = {
      state: newState(
        crypto.randomUUID(),
        "source",
        "target",
        info.sourceInfo.schema,
      ),
      save: async () => {},
    };
    let loseSQL = true,
      loseObject = true;
    const unreliable = {
      call: async (command) => {
        const result = await target.call(command);
        if (
          command.action === "write" &&
          command.table === "requests" &&
          loseSQL
        ) {
          loseSQL = false;
          throw new Error("Lost SQL ACK");
        }
        if (
          command.action === "write_object" &&
          command.snapshot.ref.kind === "oauth" &&
          loseObject
        ) {
          loseObject = false;
          throw new Error("Lost object ACK");
        }
        return result;
      },
    };
    await assert.rejects(
      transferInstances(source, unreliable, journal),
      /Lost SQL ACK/,
    );
    assert.equal(journal.state.phase, "tables");
    assert.ok(journal.state.intent);
    await assert.rejects(
      transferInstances(source, unreliable, journal),
      /Lost object ACK/,
    );
    assert.equal(journal.state.phase, "objects");
    await transferInstances(source, unreliable, journal);
    assert.equal(journal.state.phase, "completed");
    assert.equal(
      (
        await target.db
          .prepare("SELECT COUNT(*) AS count FROM requests")
          .first()
      ).count,
      55,
    );
    assert.deepEqual(
      await target.db
        .prepare("SELECT SUM(requests_count) AS count FROM usage_hourly")
        .first(),
      await source.db
        .prepare("SELECT SUM(requests_count) AS count FROM usage_hourly")
        .first(),
    );
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("data changes after a lost acknowledgement block resume and abort restores source alarms", async () => {
  const source = await instance(),
    target = await instance();
  try {
    const accounts = await seed(source);
    const alarm = Date.now() + 3600000;
    await source.storage(accounts[0].object).setAlarm(alarm);
    const info = await preflight(source, target);
    const journal = {
      state: newState(
        crypto.randomUUID(),
        "source",
        "target",
        info.sourceInfo.schema,
      ),
      save: async () => {},
    };
    const unreliable = {
      call: async (command) => {
        const value = await target.call(command);
        if (command.action === "write" && command.table === "providers")
          throw new Error("interrupt");
        return value;
      },
    };
    await assert.rejects(
      transferInstances(source, unreliable, journal),
      /interrupt/,
    );
    assert.equal(await source.storage(accounts[0].object).getAlarm(), null);
    await source.db
      .prepare("UPDATE providers SET name = 'edited' WHERE type = 'ai_gateway'")
      .run();
    await assert.rejects(
      transferInstances(source, target, journal),
      /Source changed/,
    );
    await abortTransfer(source, target, journal);
    assert.equal(await source.storage(accounts[0].object).getAlarm(), alarm);
    assert.equal(journal.state.phase, "aborted");
  } finally {
    source.db.close();
    target.db.close();
  }
});

for (const useCloudflare of [false, true])
  test(`best-effort transfer skips leftovers and resumes a prepared ${useCloudflare ? "Cloudflare" : "standard"} task`, async () => {
    const source = await instance(),
      target = await instance();
    const journal = {
      state: newState(crypto.randomUUID(), "source", "target", "schema"),
      save: async () => {},
    };
    try {
      const accounts = await seedTransferAccounts(
        source.db,
        KEY,
        async (ref, entries) => {
          for (const [key, value] of entries)
            await source.storage(ref).put(key, value);
        },
      );
      const orphan = source.storage({
        kind: "oauth",
        name: crypto.randomUUID(),
      });
      await orphan.put(
        "account",
        "undecryptable leftover from an older deployment",
      );
      await orphan.setAlarm(Date.now() + 3600000);
      const orphanAlarm = source.storage({
        kind: "health",
        name: "old-alarm-only",
      });
      await orphanAlarm.setAlarm(Date.now() + 3600000);
      const inventory = await source.call({ action: "inventory" });
      assert.deepEqual(inventory.skipped, { oauth: 1 });
      const messages = [];
      // A previous inventory failure may already have removed the target seeds.
      await target.call({ action: "prepare" });
      if (useCloudflare) {
        const call = source.call;
        source.call = async (command) => {
          const result = await call(command);
          return command.action === "inventory"
            ? { ...result, skipped: { PROVIDER_OAUTH_ACCOUNT: 1 } }
            : result;
        };
      }
      await transferInstances(source, target, journal, (message) =>
        messages.push(message),
      );
      assert.equal(journal.state.phase, "completed");
      if (useCloudflare) {
        assert.ok(
          messages.includes(
            "Skipping 1 unmapped persistent object(s) in PROVIDER_OAUTH_ACCOUNT (best effort)",
          ),
        );
      } else {
        assert.ok(
          messages.includes(
            "Skipping 1 unmapped persistent object(s) in oauth (best effort)",
          ),
        );
      }
      assert.deepEqual(
        (await target.call({ action: "inventory" })).skipped,
        {},
      );
      for (const fixture of accounts) {
        assert.equal(
          await target.storage(fixture.object).get("account"),
          fixture.ciphertext,
        );
        assert.equal(
          await target.storage(fixture.health).get("lease:reset"),
          undefined,
        );
      }
      assert.equal(
        await orphan.get("account"),
        "undecryptable leftover from an older deployment",
      );
    } finally {
      source.db.close();
      target.db.close();
    }
  });

test("best effort still rejects corrupt OAuth state referenced by SQL", async () => {
  const source = await instance(),
    target = await instance();
  const journal = {
    state: newState(crypto.randomUUID(), "source", "target", "schema"),
    save: async () => {},
  };
  try {
    const accounts = await seedTransferAccounts(
      source.db,
      KEY,
      async (ref, entries) => {
        for (const [key, value] of entries)
          await source.storage(ref).put(key, value);
      },
    );
    await source
      .storage(accounts[0].object)
      .put("account", "corrupt referenced account");
    await assert.rejects(
      transferInstances(source, target, journal),
      /read_object/,
    );
    assert.equal(journal.state.phase, "pausing");
    assert.equal(journal.state.table, 0);
    assert.equal(journal.state.object, 0);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("stale OAuth indexes are skipped before object access", async () => {
  const source = await instance(),
    target = await instance("postgres");
  const journal = {
    state: newState(crypto.randomUUID(), "source", "target", "schema"),
    save: async () => {},
  };
  try {
    const accounts = await seed(source);
    const orphan = { kind: "oauth", name: crypto.randomUUID() };
    await source.db
      .prepare(
        "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, 'codex', 1)",
      )
      .bind(orphan.name, crypto.randomUUID())
      .run();
    const leftover = source.storage(orphan);
    await leftover.put(
      "account",
      "undecryptable orphan with a stale SQL index",
    );
    const alarm = Date.now() + 3600000;
    await leftover.setAlarm(alarm);
    await source.storage(accounts[0].object).setAlarm(alarm);
    const inventory = await source.call({ action: "inventory" });
    assert.deepEqual(inventory.orphaned_oauth, [orphan.name]);
    assert.deepEqual(inventory.skipped, { oauth: 1 });
    const guarded = {
      call: async (command) => {
        assert.notDeepEqual(
          command.ref,
          orphan,
          "Do not read or schedule a remnant",
        );
        return source.call(command);
      },
    };
    const messages = [];
    await transferInstances(guarded, target, journal, (message) =>
      messages.push(message),
    );
    assert.equal(journal.state.phase, "completed");
    assert.deepEqual(journal.state.objects, inventory.objects);
    assert.ok(
      messages.some((message) =>
        message.includes("Ignoring 1 stale OAuth index"),
      ),
    );
    assert.equal(await leftover.getAlarm(), alarm);
    assert.equal(await target.storage(orphan).get("account"), undefined);
    assert.equal(await target.storage(orphan).getAlarm(), null);
    assert.deepEqual(
      (
        await target.db
          .prepare("SELECT * FROM oauth_accounts ORDER BY account_ref")
          .all()
      ).results,
      (
        await source.db
          .prepare("SELECT * FROM oauth_accounts ORDER BY account_ref")
          .all()
      ).results,
    );
    for (const fixture of accounts)
      assert.equal(
        await target.storage(fixture.object).get("account"),
        fixture.ciphertext,
      );
    assert.equal(await target.storage(accounts[0].object).getAlarm(), alarm);
  } finally {
    await source.db.close();
    await target.db.close();
  }
});

test("OAuth inventory keeps provider-owned, soft-deleted and historically referenced accounts", async () => {
  const source = await instance();
  try {
    const accounts = await seed(source);
    const providerOwned = { kind: "oauth", name: crypto.randomUUID() },
      historical = { kind: "oauth", name: crypto.randomUUID() },
      referenced = { kind: "oauth", name: crypto.randomUUID() };
    await source.db
      .prepare("UPDATE providers SET deleted_at = 1 WHERE id = ?")
      .bind(accounts[0].account.provider_id)
      .run();
    for (const ref of [providerOwned, historical, referenced])
      await source.db
        .prepare(
          "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, 'codex', 1)",
        )
        .bind(
          ref.name,
          ref === providerOwned
            ? accounts[0].account.provider_id
            : crypto.randomUUID(),
        )
        .run();
    const snapshot = config();
    snapshot.providers[0].credentials[0].auth = {
      type: "oauth",
      account_ref: historical.name,
    };
    await source.db
      .prepare("UPDATE config_snapshots SET config_json = ? WHERE version = 1")
      .bind(JSON.stringify(snapshot))
      .run();
    await source.db
      .prepare(
        "UPDATE provider_credentials SET account_ref = ? WHERE account_ref = ?",
      )
      .bind(referenced.name, accounts[0].object.name)
      .run();
    const inventory = await source.call({ action: "inventory" });
    assert.deepEqual(inventory.orphaned_oauth, []);
    for (const ref of [
      providerOwned,
      historical,
      referenced,
      ...accounts.map((a) => a.object),
    ])
      assert.ok(
        inventory.objects.some(
          (row) => row.kind === ref.kind && row.name === ref.name,
        ),
      );
  } finally {
    await source.db.close();
  }
});

test("best effort rejects a mismatched OAuth identity owned by an existing provider", async () => {
  const source = await instance(),
    target = await instance();
  const journal = {
    state: newState(crypto.randomUUID(), "source", "target", "schema"),
    save: async () => {},
  };
  try {
    const accounts = await seed(source);
    await source
      .storage(accounts[0].object)
      .put("account", accounts[1].ciphertext);
    await assert.rejects(
      transferInstances(source, target, journal),
      /OAuth account identity does not match SQL/,
    );
    assert.equal(journal.state.phase, "pausing");
    assert.equal(journal.state.table, 0);
  } finally {
    await source.db.close();
    await target.db.close();
  }
});

test("pausing resume does not discard unrelated changes to the saved inventory", async () => {
  const source = await instance(),
    target = await instance();
  const journal = {
    state: newState(crypto.randomUUID(), "source", "target", "schema"),
    save: async () => {},
  };
  try {
    await seed(source);
    await target.call({ action: "prepare" });
    journal.state.phase = "pausing";
    journal.state.objects = (
      await source.call({ action: "inventory" })
    ).objects;
    journal.state.objects.push({ kind: "oauth", name: crypto.randomUUID() });
    await assert.rejects(
      transferInstances(source, target, journal),
      /Source object inventory changed/,
    );
    assert.equal(journal.state.table, 0);
    assert.deepEqual(journal.state.alarms, {});
  } finally {
    await source.db.close();
    await target.db.close();
  }
});

test("bulk SQL transfers use page queries and multi-row inserts while ignoring runtime journals", async () => {
  const source = await instance(),
    target = await instance("postgres");
  try {
    await seed(source);
    await source.db.batch(
      Array.from({ length: 2505 }, (_, index) =>
        source.db
          .prepare(
            "INSERT INTO audit_log (id, created_at, actor, action, revision) VALUES (?, 1, 'bulk', 'test', NULL)",
          )
          .bind(`bulk-${String(index).padStart(5, "0")}`),
      ),
    );
    const ignored = source.storage({ kind: "usage", name: "invalid-journal" });
    await ignored.put("event", "unrecoverable usage is outside transfer scope");
    await source
      .storage({ kind: "proxy-group", name: "unused" })
      .put("bad", "ignored");
    const prepare = target.db.prepare.bind(target.db);
    const queries = [];
    target.db.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    const journal = {
      state: newState(crypto.randomUUID(), "source", "target", "schema"),
      save: async () => {},
    };
    await transferInstances(source, target, journal);
    const auditReads = queries.filter(
      (sql) => sql.startsWith("SELECT") && sql.includes("FROM audit_log"),
    );
    const auditWrites = queries.filter((sql) =>
      sql.startsWith("INSERT INTO audit_log"),
    );
    assert.ok(
      auditReads.length < 10,
      `Expected page queries, got ${auditReads.length}`,
    );
    assert.equal(auditWrites.length, 3);
    assert.ok(auditWrites.every((sql) => sql.includes("), (")));
    assert.equal(
      await ignored.get("event"),
      "unrecoverable usage is outside transfer scope",
    );
    assert.equal(
      (
        await target.db
          .prepare(
            "SELECT COUNT(*) AS count FROM object_storage WHERE namespace <> 'oauth'",
          )
          .first()
      ).count,
      0,
    );
  } finally {
    await source.db.close();
    await target.db.close();
  }
});

for (const direction of ["from-d1", "to-d1"]) {
  test(`native Wrangler ${direction}: exact data, ciphertext, retained rollups and lost import acknowledgement`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cody-native-transfer-test-"),
    );
    const databaseFile = join(directory, "d1.sqlite");
    const source = await instance(
      direction === "from-d1" ? "sqlite" : "postgres",
      KEY,
      databaseFile,
    );
    const target = await instance(
      direction === "to-d1" ? "sqlite" : "postgres",
      KEY,
      databaseFile,
    );
    const calls = [];
    let loseImport = true;
    const native = d1DatabaseTransfer(
      {
        account: "mock",
        bridgeConfig: () => ({ d1_databases: [{ database_id: "mock-d1" }] }),
      },
      {},
      KEY,
      async (args) => {
        calls.push(args.slice(0, 3));
        const config = JSON.parse(
          await readFile(args[args.indexOf("--config") + 1], "utf8"),
        );
        assert.equal(config.d1_databases[0].database_id, "mock-d1");
        if (args[1] === "export") {
          assert.ok(args.includes("--skip-confirmation"));
          // Older SQLite CLIs dump an orphaned sqlite_sequence after migrations
          // drop the last AUTOINCREMENT table. Internal tables are not transferred.
          const { stdout } = await promisify(execFile)(
            "sqlite3",
            ["-batch", databaseFile, ".dump --nosys"],
            { maxBuffer: 16 * 1024 * 1024 },
          );
          await writeFile(args[args.indexOf("--output") + 1], stdout);
        } else {
          assert.ok(args.includes("--yes"));
          const sql = args[args.indexOf("--file") + 1];
          assert.equal((await stat(sql)).mode & 0o777, 0o600);
          await loadSqliteDump(sql, databaseFile);
          if (loseImport) {
            loseImport = false;
            throw new Error("Lost native import ACK");
          }
        }
      },
    );
    try {
      const accounts = await seed(source);
      await seedUsage(source);
      await source.db
        .prepare(
          "INSERT INTO audit_log (id, created_at, actor, action) VALUES ('quoting', 1, ?, 'test')",
        )
        .bind("Unicode 中文\nO'Brien; -- stays data")
        .run();
      const originalMigrations = (
        await target.db
          .prepare("SELECT * FROM schema_migrations ORDER BY name")
          .all()
      ).results;
      const remote = direction === "from-d1" ? source : target;
      const endpoint = {
        ...remote,
        databaseSnapshot: native.databaseSnapshot,
        ...(direction === "to-d1"
          ? { importDatabase: native.importDatabase }
          : {}),
        call: (command) => {
          assert.ok(
            !["read", "write"].includes(command.action),
            "D1 must not transfer table pages through RPC",
          );
          return remote.call(command);
        },
      };
      const journal = {
        state: newState(crypto.randomUUID(), "source", "target", "schema"),
        save: async () => {},
      };
      const run = () =>
        transferInstances(
          direction === "from-d1" ? endpoint : source,
          direction === "to-d1" ? endpoint : target,
          journal,
        );
      if (direction === "to-d1") {
        await assert.rejects(run(), /Lost native import ACK/);
        assert.match(journal.state.import_digest, /^[a-f0-9]{64}$/);
        assert.equal(journal.state.phase, "tables");
        assert.equal(journal.state.object, 0);
      }
      await run();
      assert.equal(journal.state.phase, "completed");
      const snapshot = await native.databaseSnapshot(() => {});
      await assert.rejects(snapshot.call({ action: "prepare" }), /read-only/);
      assert.equal(calls.filter((args) => args[1] === "export").length, 1);
      assert.equal(
        calls.filter((args) => args[1] === "execute").length,
        direction === "to-d1" ? 2 : 0,
      );
      assert.deepEqual(
        (
          await target.db
            .prepare("SELECT * FROM schema_migrations ORDER BY name")
            .all()
        ).results,
        originalMigrations,
      );
      for (const fixture of accounts)
        assert.equal(
          await target.storage(fixture.object).get("account"),
          fixture.ciphertext,
        );
      assert.equal(
        (
          await target.db
            .prepare(
              "SELECT COUNT(*) AS count FROM object_storage WHERE namespace <> 'oauth'",
            )
            .first()
        ).count,
        0,
      );
    } finally {
      await native.close();
      await source.db.close();
      await target.db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("D1 import safely encodes NUL text and refuses changed import contents before another write", async () => {
  const source = await instance(),
    target = await instance();
  const directory = await mkdtemp(join(tmpdir(), "cody-import-test-"));
  try {
    await source.db
      .prepare(
        "INSERT INTO audit_log (id, created_at, actor, action) VALUES ('binary-text', 1, ?, 'test')",
      )
      .bind("x\0y'\n雪")
      .run();
    const filename = join(directory, "data.sql");
    await writeD1Import(source, filename);
    await target.db.exec(await readFile(filename, "utf8"));
    assert.equal(
      (await target.db.prepare("SELECT actor FROM audit_log").first()).actor,
      "x\0y'\n雪",
    );
    const journal = {
      state: newState(crypto.randomUUID(), "source", "target", "schema"),
      save: async () => {},
    };
    journal.state.phase = "tables";
    journal.state.import_digest = "a".repeat(64);
    let writes = 0;
    target.importDatabase = async (endpoint, saveIntent) => {
      await saveIntent(await writeD1Import(endpoint, filename));
      writes++;
    };
    await assert.rejects(
      transferInstances(source, target, journal),
      /Source changed since the interrupted import/,
    );
    assert.equal(writes, 0);
  } finally {
    await source.db.close();
    await target.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot references are deduplicated and checked in batches across a history page", async () => {
  const source = await instance();
  try {
    const accounts = await seed(source);
    const { config_json } = await source.db
      .prepare("SELECT config_json FROM config_snapshots WHERE version = 1")
      .first();
    const snapshot = JSON.parse(config_json);
    snapshot.providers[0].credentials.push({
      auth: { type: "oauth", account_ref: accounts[0].object.name },
    });
    const references = Array.from({ length: 1000 }, () => ({
      config_json: JSON.stringify(snapshot),
    }));
    let queries = 0;
    await validateSnapshotReferences(
      {
        prepare: (sql) => {
          queries++;
          return source.db.prepare(sql);
        },
      },
      references,
    );
    assert.ok(
      queries > 0 && queries < 10,
      `${queries} queries for 1000 snapshots`,
    );
  } finally {
    source.db.close();
  }
});
