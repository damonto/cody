import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import { ControlStore } from "../src/control/store.ts";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
async function database() {
  const db = await createSqliteDatabase(":memory:");
  for (const name of (
    await readdir(new URL("../migrations/d1/", import.meta.url))
  )
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      await readFile(
        new URL(`../migrations/d1/${name}`, import.meta.url),
        "utf8",
      ),
    );
  return db;
}
function config() {
  return {
    providers: [
      {
        id: "new-provider",
        name: "Upstream",
        type: "ai_gateway",
        base_url: "https://example.test/v1",
        priority: 100,
        disabled: false,
        models: ["model"],
        credentials: [
          {
            id: "new-credential",
            name: "Primary",
            auth: { type: "api_key", api_key: "upstream-secret" },
            priority: 100,
            disabled: false,
          },
        ],
      },
    ],
    api_keys: [
      {
        id: "new-client",
        name: "Client",
        api_key: "client-secret",
        providers: ["new-provider"],
      },
    ],
    proxy_groups: [],
    model_routes: { alias: { model: "model", providers: ["new-provider"] } },
    web_search: { mode: "proxy" },
    model_prices: [
      {
        provider_id: "new-provider",
        model: "model",
        pricing: {
          currency: "USD",
          tiers: [
            {
              up_to_input_tokens: null,
              input: "1",
              output: "2",
              cache_read: "0",
              cache_write: "0",
            },
          ],
        },
      },
    ],
  };
}
test("a save assigns UUIDs, writes relational entities and commits an encrypted-secret snapshot", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const result = await store.save(config(), 0, "test");
    assert.equal(result.version, 1);
    const current = await store.current();
    assert.match(current.providers[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(current.providers[0].name, "Upstream");
    assert.equal(current.api_keys[0].providers[0], current.providers[0].id);
    assert.equal(
      current.model_routes.alias.providers[0],
      current.providers[0].id,
    );
    assert.equal(
      current.providers[0].credentials[0].auth.api_key,
      "upstream-secret",
    );
    assert.equal(
      result.config.providers[0].credentials[0].auth.api_key,
      "__CODY_SECRET_UNCHANGED__",
    );
    const snapshot = await db
      .prepare("SELECT config_json FROM config_snapshots")
      .first();
    assert.ok(!snapshot.config_json.includes("upstream-secret"));
    const secrets = await db
      .prepare("SELECT ciphertext FROM secret_versions")
      .all();
    assert.equal(secrets.results.length, 2);
    assert.ok(!JSON.stringify(secrets).includes("client-secret"));
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM model_prices").first()).n,
      1,
    );
  } finally {
    db.close();
  }
});
test("masked saves retain identities and secrets; stale writes have no effects", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const saved = await store.save(config(), 0, "test");
    saved.config.providers[0].name = "Renamed";
    const next = await store.save(saved.config, 1, "test");
    assert.equal(next.config.providers[0].id, saved.config.providers[0].id);
    await assert.rejects(store.save(saved.config, 1, "other"), /changed/);
    assert.equal((await store.state()).version, 2);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM secret_versions").first()).n,
      2,
    );
    assert.equal(
      (await store.current()).providers[0].credentials[0].auth.api_key,
      "upstream-secret",
    );
  } finally {
    db.close();
  }
});
test("transaction errors roll back entities, snapshot, secrets and version", async () => {
  const db = await database();
  try {
    const providersBefore = await db
      .prepare("SELECT * FROM providers ORDER BY id")
      .all();
    await db.exec(
      "CREATE TRIGGER reject_config_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    const store = new ControlStore(db, key);
    await assert.rejects(store.save(config(), 0, "test"), /audit unavailable/);
    assert.equal((await store.state()).version, 0);
    assert.deepEqual(
      await db.prepare("SELECT * FROM providers ORDER BY id").all(),
      providersBefore,
    );
    for (const table of [
      "clients",
      "secret_versions",
      "config_snapshots",
      "model_price_versions",
    ])
      assert.equal(
        (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,
        0,
      );
  } finally {
    db.close();
  }
});
test("idempotent retries return the original result and reject reused operation IDs", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const id = crypto.randomUUID();
    const input = config();
    const first = await store.save(input, 0, "test", id);
    const second = await store.save(input, 0, "test", id);
    assert.deepEqual(first, second);
    assert.equal((await store.state()).version, 1);
    await assert.rejects(
      store.save({ ...input, providers: [] }, 0, "test", id),
      /already used/,
    );
  } finally {
    db.close();
  }
});
test("deletion keeps entity records and historical snapshots", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const saved = await store.save(config(), 0, "test");
    await store.save(
      {
        providers: [],
        api_keys: [],
        proxy_groups: [],
        model_routes: {},
        web_search: { mode: "proxy" },
      },
      1,
      "test",
    );
    assert.equal((await store.current()).providers.length, 0);
    const row = await db
      .prepare("SELECT deleted_at FROM providers WHERE id = ?")
      .bind(saved.config.providers[0].id)
      .first();
    assert.ok(row.deleted_at);
    assert.equal((await store.revision(1)).providers[0].name, "Upstream");
  } finally {
    db.close();
  }
});

test("concurrent reuse of an operation ID cannot split entities from its snapshot", async () => {
  const db = await database();
  try {
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const tagged = new WeakSet();
    const racing = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("UPDATE config_meta")) return statement;
        return {
          ...statement,
          bind: (...values) => {
            const bound = statement.bind(...values);
            tagged.add(bound);
            return bound;
          },
        };
      },
      async batch(statements) {
        if (tagged.has(statements[0])) {
          if (++waiting === 2) release();
          await barrier;
        }
        return db.batch(statements);
      },
    };
    const store = new ControlStore(racing, key);
    const id = crypto.randomUUID();
    const first = config();
    const second = config();
    second.providers[0].name = "Other name";
    const results = await Promise.allSettled([
      store.save(first, 0, "test", id),
      store.save(second, 0, "test", id),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.deepEqual(await store.current(), await store.revision(1));
  } finally {
    await db.close();
  }
});

test("names resembling secret references stay literal and route renames retain identity", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const input = config();
    input.providers[0].name = `__cody_secret:${crypto.randomUUID()}`;
    const saved = await store.save(input, 0, "test");
    assert.equal(saved.config.providers[0].name, input.providers[0].name);
    const route = saved.config.model_routes.alias;
    saved.config.model_routes = { renamed: route };
    const next = await store.save(saved.config, 1, "test");
    assert.equal(next.config.model_routes.renamed.id, route.id);
    assert.deepEqual(await store.current(), await store.revision(2));
  } finally {
    await db.close();
  }
});

test("restoring a snapshot keeps rotated proxy and search secrets and is idempotent", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const input = config();
    input.proxy_groups = [
      {
        id: "proxy",
        name: "Proxy",
        strategy: "priority",
        proxies: [
          {
            id: "node",
            name: "Node",
            url: "socks5://proxy.test:1080",
            username: "user",
            password: "old-password",
            priority: 100,
            disabled: false,
          },
        ],
      },
    ];
    input.web_search = {
      mode: "tavily",
      api_key: "old-search",
      base_url: "https://api.tavily.com",
      max_results: 5,
    };
    await store.save(input, 0, "test");
    const next = await store.current();
    next.proxy_groups[0].proxies[0].password = "new-password";
    next.web_search.api_key = "new-search";
    next.providers[0].name = "Changed";
    await store.save(next, 1, "test");
    const id = crypto.randomUUID();
    const restored = await store.restore(1, 2, "test", id);
    assert.equal(restored.version, 3);
    assert.deepEqual(await store.restore(1, 2, "test", id), restored);
    const current = await store.current();
    assert.equal(current.proxy_groups[0].proxies[0].password, "new-password");
    assert.equal(current.web_search.api_key, "new-search");
    assert.equal(current.providers[0].name, "Upstream");
  } finally {
    await db.close();
  }
});

for (const kind of ["clients", "provider_credentials", "proxy_nodes"]) {
  test(`snapshot restoration cannot revive deleted ${kind} or change the version on failure`, async () => {
    const db = await database();
    try {
      const store = new ControlStore(db, key);
      const input = config();
      input.proxy_groups = [
        {
          id: "group",
          name: "Group",
          strategy: "priority",
          proxies: [
            {
              id: "node",
              name: "Node",
              url: "socks5://proxy.test:1080",
              priority: 100,
              disabled: false,
            },
          ],
        },
      ];
      const first = await store.save(input, 0, "test");
      const id =
        kind === "clients"
          ? first.config.api_keys[0].id
          : kind === "provider_credentials"
            ? first.config.providers[0].credentials[0].id
            : first.config.proxy_groups[0].proxies[0].id;
      const next = await store.current();
      if (kind === "clients") next.api_keys = [];
      else if (kind === "provider_credentials") {
        next.providers[0].credentials = [
          {
            id: "replacement",
            name: "Replacement",
            auth: { type: "api_key", api_key: "replacement-key" },
            priority: 100,
            disabled: false,
          },
        ];
      } else next.proxy_groups = [];
      await store.save(next, 1, "test");
      const current = await store.current();
      await assert.rejects(store.restore(1, 2, "test"), /references deleted/);
      assert.equal((await store.state()).version, 2);
      assert.deepEqual(await store.current(), current);
      assert.ok(
        (
          await db
            .prepare(`SELECT deleted_at FROM ${kind} WHERE id = ?`)
            .bind(id)
            .first()
        ).deleted_at,
      );
    } finally {
      await db.close();
    }
  });
}

test("switching search providers requires an explicit new key", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const input = config();
    input.web_search = {
      mode: "tavily",
      api_key: "search-key",
      base_url: "https://api.tavily.com",
      max_results: 5,
    };
    const first = await store.save(input, 0, "test");
    first.config.web_search = {
      mode: "exa",
      api_key: first.config.web_search.api_key,
      base_url: "https://api.exa.ai",
      max_results: 5,
    };
    await assert.rejects(store.save(first.config, 1, "test"), /new credential/);
    assert.equal((await store.state()).version, 1);
    first.config.web_search.api_key = "new-search-key";
    await store.save(first.config, 1, "test");
    assert.equal((await store.current()).web_search.api_key, "new-search-key");
  } finally {
    await db.close();
  }
});

test("renaming an entity does not issue updates to unchanged credentials", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const first = await store.save(config(), 0, "test");
    await db.exec(
      "CREATE TRIGGER reject_credential_update BEFORE UPDATE ON provider_credentials BEGIN SELECT RAISE(ABORT, 'credential should not change'); END",
    );
    first.config.providers[0].name = "Renamed";
    await store.save(first.config, 1, "test");
    assert.equal((await store.state()).version, 2);
  } finally {
    await db.close();
  }
});

test("price ordering cannot make relational configuration differ from its snapshot", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const input = config();
    input.providers[0].models.push("second-model");
    input.model_prices.push({
      ...structuredClone(input.model_prices[0]),
      model: "second-model",
    });
    const first = await store.save(input, 0, "test");
    first.config.model_prices.reverse();
    await store.save(first.config, 1, "test");
    assert.deepEqual(await store.current(), await store.revision(2));
  } finally {
    await db.close();
  }
});

test("historical restoration does not decrypt revoked historical keys", async () => {
  const db = await database();
  try {
    const store = new ControlStore(db, key);
    const first = await store.save(config(), 0, "test");
    const old = await db
      .prepare("SELECT secret_id FROM clients WHERE id = ?")
      .bind(first.config.api_keys[0].id)
      .first();
    const next = structuredClone(first.config);
    next.api_keys[0].api_key = "rotated-client-secret";
    await store.save(next, 1, "test");
    await db
      .prepare("UPDATE secret_versions SET revoked_at = 1 WHERE id = ?")
      .bind(old.secret_id)
      .run();
    await store.restore(1, 2, "test");
    assert.equal(
      (await store.current()).api_keys[0].api_key,
      "rotated-client-secret",
    );
    assert.equal((await store.state()).version, 3);
  } finally {
    await db.close();
  }
});
