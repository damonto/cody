import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { config as configFixture, usage } from "./admin/fixtures.ts";
import { ControlStore } from "../src/control/store.ts";
import {
  cleanupRequests,
  expirePendingRequests,
  ingestUsage,
  reportDimensions,
  requestDetail,
  requestList,
  summary,
} from "../src/reporting/store.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import {
  numberPlaceholders,
  pgliteQueryable,
  postgresDatabase,
} from "../src/platform/standard/sql/postgres.ts";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOUR_MS = 3_600_000;
const range = (from, to) => ({ from, to, time_zone: "UTC", period: "custom" });

const factories = {
  sqlite: async () => createSqliteDatabase(":memory:"),
  postgres: async () => postgresDatabase(pgliteQueryable(new PGlite())),
};

test("placeholders are numbered outside string literals", () => {
  assert.equal(
    numberPlaceholders("SELECT ?, '?' FROM t WHERE a = ? AND b = 'x?'"),
    "SELECT $1, '?' FROM t WHERE a = $2 AND b = 'x?'",
  );
});

for (const [dialect, create] of Object.entries(factories)) {
  test(`${dialect}: migrations apply once`, async () => {
    const db = await create();
    const first = await applyMigrations(
      db,
      migrationDirectories(dialect, ROOT),
    );
    assert.deepEqual(first, [
      "0001_control_and_usage.sql",
      "0007_oauth_accounts.sql",
      "1001_object_storage.sql",
    ]);
    assert.deepEqual(
      await applyMigrations(db, migrationDirectories(dialect, ROOT)),
      [],
    );
  });

  test(`${dialect}: usage ingestion, rollup and reports`, async () => {
    const db = await create();
    await applyMigrations(db, migrationDirectories(dialect, ROOT));
    const base = Date.UTC(2026, 8, 12, 10);
    const finished = usage("req-finished", base + 60_000);
    const started = {
      ...finished,
      sequence: 0,
      phase: "started",
      finished_at: null,
      outcome: "pending",
      first_response_ms: null,
    };
    await ingestUsage(db, started);
    await ingestUsage(db, finished);
    await ingestUsage(db, finished);
    const rollup = await db
      .prepare("SELECT requests_count, success_count FROM usage_hourly")
      .all();
    assert.equal(rollup.results.length, 1);
    assert.equal(Number(rollup.results[0].requests_count), 1);
    assert.equal(Number(rollup.results[0].success_count), 1);

    const detail = await requestDetail(db, "req-finished");
    assert.equal(detail?.request_id, "req-finished");

    const window = range(base, base + 2 * HOUR_MS);
    const report = await summary(db, window, {});
    assert.equal(report.totals.requests_count, 1);
    const dims = await reportDimensions(db, window);
    assert.deepEqual(dims.providers, ["provider"]);
    const list = await requestList(db, window, {}, { limit: 10 });
    assert.equal(list.items.length, 1);

    const pending = usage("req-pending", base + 120_000);
    const pendingStart = {
      ...pending,
      sequence: 0,
      phase: "started",
      finished_at: null,
      outcome: "pending",
      first_response_ms: null,
    };
    await ingestUsage(db, pendingStart);
    const expired = await expirePendingRequests(db, 1000, base + HOUR_MS);
    assert.equal(expired, 1);
    const reaped = await requestDetail(db, "req-pending");
    assert.equal(reaped?.phase, "finished");
    assert.equal(reaped?.diagnostic_code, "worker_terminated");
    assert.equal(reaped?.duration_ms, null);

    await cleanupRequests(db, 0);
    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM requests")
      .first();
    assert.equal(Number(remaining?.count), 0);
  });

  test(`${dialect}: control store draft, revision and publish`, async () => {
    const db = await create();
    await applyMigrations(db, migrationDirectories(dialect, ROOT));
    const kv = new Map();
    const store = new ControlStore(
      db,
      {
        get: async (key) => kv.get(key) ?? null,
        put: async (key, value) => void kv.set(key, value),
        delete: async (key) => void kv.delete(key),
      },
      KEY,
      "gateway-config",
    );
    const state = await store.state();
    assert.equal(state.draft_version, 0);
    const config = configFixture();
    const view = await store.save(config, 0, "tester");
    assert.equal(view.version, 1);
    await assert.rejects(store.save(config, 0, "tester"), /draft changed/);
    const audits = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'save_draft'",
      )
      .first();
    assert.equal(Number(audits?.count), 1);

    const revision = await store.createRevision(1, "tester");
    await store.publishRevision(revision);
    await store.publishRevision(revision);
    assert.equal((await store.state()).published_revision, revision);
    assert.ok(kv.get("gateway-config"));
    assert.equal((await store.revision(revision)).revision, revision);
  });
}
