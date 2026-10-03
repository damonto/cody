import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import { checkExpiredUsageCorrection } from "./helpers/expired-usage.ts";
import { checkIncrementalConfiguration } from "./helpers/entity-configuration.ts";

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
  test(`${dialect}: saves touch only changed rows and swap aliases atomically`, async () => {
    const db = await create();
    await applyMigrations(db, migrationDirectories(dialect, ROOT));
    await checkIncrementalConfiguration(db, KEY);
  });
  test(`${dialect}: correction migration marks historical inferred failures without changing rollups`, async () => {
    const db = await create();
    const directory = migrationDirectories(dialect, ROOT)[0];
    await db.exec(
      await readFile(`${directory}/0001_control_and_usage.sql`, "utf8"),
    );
    for (const [id, code, duration] of [
      ["expired", "worker_terminated", null],
      ["observed", "worker_terminated", 19_000],
      ["upstream", "upstream_error", null],
    ]) {
      await db
        .prepare(
          `INSERT INTO requests (
        request_id, event_sequence, started_at, finished_at, endpoint, protocol,
        transport, outcome, duration_ms, usage_status, billing_status, event_json
      ) VALUES (?, 2, ?, ?, 'responses', 'openai', 'http', 'failed', ?, 'missing', 'incomplete', ?)`,
        )
        .bind(
          id,
          Date.UTC(2026, 8, 14, 10),
          Date.UTC(2026, 8, 14, 11),
          duration,
          JSON.stringify({
            diagnostic_code: code,
            observation_issue: "stream_abandoned",
          }),
        )
        .run();
    }
    const before = (await db.prepare("SELECT * FROM usage_hourly").all())
      .results;
    await db.exec(
      await readFile(`${directory}/0011_correct_expired_usage.sql`, "utf8"),
    );
    assert.deepEqual(
      (
        await db
          .prepare(
            "SELECT request_id, is_provisional FROM requests ORDER BY request_id",
          )
          .all()
      ).results,
      [
        { request_id: "expired", is_provisional: 1 },
        { request_id: "observed", is_provisional: 0 },
        { request_id: "upstream", is_provisional: 0 },
      ],
    );
    assert.deepEqual(
      (await db.prepare("SELECT * FROM usage_hourly").all()).results,
      before,
    );
  });
  test(`${dialect}: late terminal usage corrects provisional failures atomically`, async () => {
    const db = await create();
    await applyMigrations(db, migrationDirectories(dialect, ROOT));
    await checkExpiredUsageCorrection(db);
  });
  test(`${dialect}: migrations apply once`, async () => {
    const db = await create();
    const first = await applyMigrations(
      db,
      migrationDirectories(dialect, ROOT),
    );
    assert.deepEqual(first, [
      "0001_control_and_usage.sql",
      "0007_oauth_accounts.sql",
      "0008_codex_oauth_accounts.sql",
      "0009_claude_oauth_accounts.sql",
      "0010_xai_oauth_accounts.sql",
      "0011_correct_expired_usage.sql",
      "0012_entity_configuration.sql",
      "0015_native_provider_defaults.sql",
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

  test(`${dialect}: configuration entities and snapshots commit atomically`, async () => {
    const db = await create();
    await applyMigrations(db, migrationDirectories(dialect, ROOT));
    const store = new ControlStore(db, KEY);
    assert.equal((await store.state()).version, 0);
    const config = configFixture();
    for (const provider of config.providers) {
      provider.name = provider.id;
      for (const credential of provider.credentials)
        credential.name = credential.id;
    }
    for (const client of config.api_keys) client.name = client.id;
    const view = await store.save(config, 0, "tester");
    assert.equal(view.version, 1);
    await assert.rejects(
      store.save(config, 0, "tester"),
      /Configuration changed/,
    );
    assert.equal(
      (await store.current()).providers[0].id,
      view.config.providers[0].id,
    );
    assert.equal((await store.revision(1)).revision, 1);
    assert.equal(
      Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'save_configuration'",
            )
            .first()
        ).count,
      ),
      1,
    );
  });
}
