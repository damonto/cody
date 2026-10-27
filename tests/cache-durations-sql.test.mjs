import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import { createTestPostgresDatabase } from "./helpers/postgres.mjs";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import {
  ingestUsage,
  requestDetail,
  summary,
  expirePendingRequests,
} from "../src/reporting/store.ts";
import { usage, config } from "./admin/fixtures.ts";
import { ControlStore } from "../src/control/store.ts";
import {
  newCodexProvider,
  newClaudeProvider,
} from "./helpers/native-provider-fixtures.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const script = await readFile(
  new URL(
    "../scripts/sql/migrate-codex-cache-durations.postgres.sql",
    import.meta.url,
  ),
  "utf8",
);
for (const [dialect, create] of Object.entries({
  sqlite: () => createSqliteDatabase(":memory:"),
  postgres: createTestPostgresDatabase,
})) {
  test(`${dialect}: duration rollups survive duplicates, reordered events and provisional corrections`, async (t) => {
    const db = await create();
    t.after(() => db.close());
    await applyMigrations(db, migrationDirectories(dialect, ROOT));
    const base = Date.UTC(2026, 9, 27, 1);
    const terminal = usage("duration", base + 1000);
    terminal.usage.tokens.cache_write_30m_tokens = 40;
    terminal.usage.tokens.cache_write_12h_tokens = 60;
    const started = {
      ...terminal,
      sequence: 0,
      phase: "started",
      finished_at: null,
      outcome: "pending",
    };
    // A terminal-before-start event is counted once.
    await ingestUsage(db, terminal);
    await ingestUsage(db, started);
    await ingestUsage(db, terminal);
    assert.equal(
      (await requestDetail(db, terminal.request_id)).usage.tokens
        .cache_write_12h_tokens,
      60,
    );
    const second = { ...terminal, request_id: "second" };
    await ingestUsage(db, { ...started, request_id: second.request_id });
    await ingestUsage(db, second);
    // Maintenance can provisionally settle known usage, then the final event
    // moves both routing bucket and counts. This covers subtraction as well as addition.
    const late = { ...terminal, request_id: "late" };
    await ingestUsage(db, { ...started, request_id: late.request_id });
    await expirePendingRequests(db, 1000, base + 3_600_000);
    late.provider_id = "another-provider";
    late.usage = structuredClone(terminal.usage);
    late.usage.tokens.cache_write_30m_tokens = 70;
    late.usage.tokens.cache_write_12h_tokens = 30;
    await ingestUsage(db, late);
    await ingestUsage(db, late);
    const old = usage("historical", base + 2000);
    await ingestUsage(db, old);
    assert.equal(
      (await requestDetail(db, old.request_id)).usage.tokens
        .cache_write_30m_tokens,
      null,
    );
    for (const range of [
      { from: base, to: base + 3_600_000 },
      { from: base + 500, to: base + 3_599_500 },
    ]) {
      const report = await summary(
        db,
        { ...range, time_zone: "UTC", period: "custom" },
        {},
      );
      assert.equal(report.totals.requests_count, 4);
      assert.equal(report.totals.cache_write_tokens, 400);
      assert.equal(report.totals.cache_write_30m_tokens, 150);
      assert.equal(report.totals.cache_write_12h_tokens, 150);
    }
    const rows = (
      await db
        .prepare(
          "SELECT provider_id, requests_count, cache_write_30m_tokens, cache_write_12h_tokens FROM usage_hourly ORDER BY provider_id",
        )
        .all()
    ).results;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [
        row.provider_id,
        Number(row.requests_count),
        Number(row.cache_write_30m_tokens),
        Number(row.cache_write_12h_tokens),
      ]),
      [
        ["another-provider", 1, 70, 30],
        ["provider", 3, 80, 120],
      ],
    );
  });
}

async function seed(db) {
  await applyMigrations(db, migrationDirectories("postgres", ROOT));
  const input = config();
  const codex = { ...newCodexProvider(), models: ["a", "b", "retired"] };
  const claude = { ...newClaudeProvider(), models: ["claude"] };
  input.providers.push(codex, claude);
  const tier = input.model_prices[0].pricing.tiers[0];
  input.model_prices.push(
    {
      provider_id: codex.id,
      model: "a",
      pricing: {
        currency: "USD",
        tiers: [
          {
            ...tier,
            up_to_input_tokens: 200000,
            cache_write_5m: "1.25",
            cache_write_1h: "2",
          },
          {
            ...tier,
            cache_write_5m: "2.50",
            cache_write_1h: "4",
            cache_write_30m: "0",
            cache_write_12h: "8",
          },
        ],
      },
    },
    {
      provider_id: codex.id,
      model: "b",
      pricing: { currency: "USD", tiers: [{ ...tier, cache_write_1h: "6" }] },
    },
    {
      provider_id: codex.id,
      model: "retired",
      pricing: { currency: "USD", tiers: [{ ...tier, cache_write_5m: "10" }] },
    },
    {
      provider_id: claude.id,
      model: "claude",
      pricing: {
        currency: "USD",
        tiers: [{ ...tier, cache_write_5m: "1.25", cache_write_1h: "2" }],
      },
    },
  );
  const store = new ControlStore(db, KEY);
  const first = await store.save(input, 0, "test");
  const next = {
    ...first.config,
    model_prices: first.config.model_prices.filter(
      (price) => price.model !== "retired",
    ),
  };
  const savedView = await store.save(next, first.version, "test");
  const saved = { ...savedView, config: await store.current() };
  return {
    store,
    saved,
    codex: saved.config.providers.find((provider) => provider.type === "codex"),
  };
}

test("PostgreSQL configuration SQL preserves amounts, identities, secrets and immutable history", async (t) => {
  const db = createTestPostgresDatabase();
  t.after(() => db.close());
  const { store, saved, codex } = await seed(db);
  const history = (
    await db.prepare("SELECT * FROM model_price_versions ORDER BY id").all()
  ).results;
  const snapshots = (
    await db.prepare("SELECT * FROM config_snapshots ORDER BY version").all()
  ).results;
  const secrets = (
    await db.prepare("SELECT * FROM secret_versions ORDER BY id").all()
  ).results;
  const retired = (
    await db
      .prepare("SELECT * FROM model_prices WHERE deleted_at IS NOT NULL")
      .all()
  ).results;
  await ingestUsage(db, usage("historical", 1000));
  const historical = await requestDetail(db, "historical");
  await db.exec(script);
  const current = await store.current();
  assert.deepEqual(
    current.model_prices.map((price) => price.id),
    saved.config.model_prices.map((price) => price.id),
  );
  assert.equal(current.revision, saved.version + 1);
  const migrated = current.model_prices.filter(
    (price) => price.provider_id === codex.id,
  );
  assert.equal(migrated.length, 2);
  for (const price of migrated) {
    const old = saved.config.model_prices.find((item) => item.id === price.id);
    assert.ok(old);
    assert.notEqual(price.version_id, old.version_id);
    for (const [index, tier] of price.pricing.tiers.entries()) {
      const previous = old.pricing.tiers[index];
      assert.equal(
        tier.cache_write_30m,
        previous.cache_write_30m ?? previous.cache_write_5m,
      );
      assert.equal(
        tier.cache_write_12h,
        previous.cache_write_12h ?? previous.cache_write_1h,
      );
      assert.equal(Object.hasOwn(tier, "cache_write_5m"), false);
      assert.equal(Object.hasOwn(tier, "cache_write_1h"), false);
    }
  }
  for (const price of current.model_prices.filter(
    (price) => price.provider_id !== codex.id,
  )) {
    assert.deepEqual(
      price.pricing,
      saved.config.model_prices.find((old) => old.id === price.id).pricing,
    );
  }
  assert.deepEqual(await store.revision(saved.version), saved.config);
  assert.deepEqual(
    (await db.prepare("SELECT * FROM secret_versions ORDER BY id").all())
      .results,
    secrets,
  );
  assert.deepEqual(
    (
      await db
        .prepare("SELECT * FROM model_prices WHERE deleted_at IS NOT NULL")
        .all()
    ).results,
    retired,
  );
  for (const old of history)
    assert.deepEqual(
      await db
        .prepare("SELECT * FROM model_price_versions WHERE id = ?")
        .bind(old.id)
        .first(),
      old,
    );
  for (const old of snapshots)
    assert.deepEqual(
      await db
        .prepare("SELECT * FROM config_snapshots WHERE version = ?")
        .bind(old.version)
        .first(),
      old,
    );
  assert.deepEqual(await requestDetail(db, "historical"), historical);
  const state = await store.state();
  await db.exec(script);
  assert.deepEqual(await store.state(), state);
  assert.deepEqual(await store.current(), current);
  const compiled = (
    await store.resource(
      ["model_prices", "provider_models"],
      (rows) => rows.model_prices,
    )
  ).item;
  for (const price of migrated)
    assert.deepEqual(
      JSON.parse(compiled.find((row) => row.id === price.id).pricing_json),
      price.pricing,
    );
});

test("PostgreSQL configuration SQL rolls back every change when the final audit write fails", async (t) => {
  const db = createTestPostgresDatabase();
  t.after(() => db.close());
  const { store, saved } = await seed(db);
  const before = (
    await db.prepare("SELECT * FROM model_prices ORDER BY id").all()
  ).results;
  await db.exec(
    "CREATE FUNCTION reject_migration_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END; $$; CREATE TRIGGER reject_migration_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_migration_audit();",
  );
  await assert.rejects(db.exec(script), /test audit failure/);
  await db.exec("ROLLBACK");
  assert.equal((await store.state()).version, saved.version);
  assert.deepEqual(await store.current(), saved.config);
  assert.deepEqual(
    (await db.prepare("SELECT * FROM model_prices ORDER BY id").all()).results,
    before,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) AS count FROM config_snapshots").first())
      .count,
    saved.version,
  );
});
