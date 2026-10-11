import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { usage } from "./admin/fixtures.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import {
  pgliteQueryable,
  postgresDatabase,
} from "../src/platform/standard/sql/postgres.ts";
import { ingestUsage, requestDetail, summary } from "../src/reporting/store.ts";

const sql = await readFile(
  new URL("../scripts/repair-codex-review-cancelled.sql", import.meta.url),
  "utf8",
);
const exampleId = "5131e3e6-b179-4c46-881d-515cd58c016f";
const startedAt = Date.parse("2026-10-11T12:48:41+08:00");
const hour = Math.floor(startedAt / 3_600_000) * 3_600_000;
const previewSql = sql.replace(/COMMIT;\s*$/, "ROLLBACK;");

async function fixture(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  const db = postgresDatabase(pgliteQueryable(pg));
  await applyMigrations(
    db,
    migrationDirectories(
      "postgres",
      fileURLToPath(new URL("..", import.meta.url)),
    ),
  );
  const provider = await db
    .prepare("SELECT id FROM providers WHERE type = 'codex'")
    .first();
  const event = usage(exampleId, startedAt);
  Object.assign(event, {
    model: "codex-auto-review",
    requested_model: "codex-auto-review",
    provider_id: provider.id,
    transport: "sse",
    outcome: "cancelled",
    response_id: "resp_completed_example",
  });
  await ingestUsage(db, event);
  return { pg, db, event };
}

async function snapshot(pg) {
  return Promise.all(
    [
      "SELECT * FROM requests ORDER BY request_id",
      "SELECT * FROM request_attempts ORDER BY request_id, attempt",
      `SELECT * FROM usage_hourly
       ORDER BY hour, client_id, provider_id, credential_id, model, kind, currency`,
    ].map(async (query) => (await pg.query(query)).rows),
  );
}

test("PostgreSQL Codex repair supports previewing without persisting changes", async (t) => {
  const { pg } = await fixture(t);
  const before = await snapshot(pg);
  const result = await pg.exec(previewSql);
  assert.ok(result.some((item) => item.rows?.[0]?.corrected_requests === 1));
  assert.deepEqual(await snapshot(pg), before);
});

test("PostgreSQL Codex repair commits all historical candidates and preserves retained totals and billing", async (t) => {
  const { pg, db, event } = await fixture(t);
  const additional = [
    { request_id: "same-bucket" },
    {
      request_id: "other-currency",
      billing: { ...event.billing, currency: "EUR" },
    },
    {
      request_id: "older-candidate",
      started_at: event.started_at - 86_400_000,
      finished_at: event.finished_at - 86_400_000,
      client_id: "another-client",
      credential_id: "another-credential",
    },
    { request_id: "retention-deleted" },
  ];
  for (const fields of additional)
    await ingestUsage(db, { ...event, ...fields });
  await pg.exec("DELETE FROM requests WHERE request_id = 'retention-deleted'");
  await pg.query(
    `UPDATE requests SET details_json =
       (details_json::jsonb || '{"outcome":"cancelled"}'::jsonb)::text
     WHERE request_id = $1`,
    [exampleId],
  );
  const [requests, attempts, buckets] = await snapshot(pg);
  const result = await pg.exec(sql);
  assert.ok(result.some((item) => item.rows?.[0]?.corrected_requests === 4));
  const after = await snapshot(pg);
  assert.deepEqual(
    after[0],
    requests.map((row) => {
      return {
        ...row,
        outcome: "success",
        details_json:
          row.request_id === exampleId
            ? after[0].find((item) => item.request_id === exampleId)
                .details_json
            : row.details_json,
      };
    }),
  );
  const previousDetails = JSON.parse(
    requests.find((row) => row.request_id === exampleId).details_json,
  );
  const newDetails = JSON.parse(
    after[0].find((row) => row.request_id === exampleId).details_json,
  );
  assert.deepEqual(newDetails, { ...previousDetails, outcome: "success" });
  assert.deepEqual(after[1], attempts);
  assert.deepEqual(
    after[2],
    buckets.map((row) => {
      const delta = row.hour === hour && row.currency === "USD" ? 2 : 1;
      return {
        ...row,
        success_count: row.success_count + delta,
        cancelled_count: row.cancelled_count - delta,
      };
    }),
  );
  assert.equal((await requestDetail(db, exampleId)).outcome, "success");
  // Reports read both full hourly buckets and partial-hour request details.
  for (const [from, to, count, successes] of [
    [hour, hour + 3_600_000, 4, 3],
    [startedAt, startedAt + 60_000, 3, 3],
    [hour - 86_400_000, hour - 86_400_000 + 3_600_000, 1, 1],
  ]) {
    const report = await summary(
      db,
      { from, to, time_zone: "UTC", period: "custom" },
      {},
    );
    assert.equal(report.totals.requests_count, count);
    assert.equal(report.totals.success_count, successes);
    assert.equal(report.totals.cancelled_count, count - successes);
  }
  const rerun = await pg.exec(sql);
  assert.ok(rerun.some((item) => item.rows?.[0]?.corrected_requests === 0));
  await ingestUsage(db, event); // Duplicate delivery must not undo the repair.
  assert.deepEqual(await snapshot(pg), after);
});

test("PostgreSQL Codex bulk repair excludes requests that do not match the candidate filters", async (t) => {
  const { pg, db, event } = await fixture(t);
  for (const fields of [
    { request_id: "bad-status", http_status: 500 },
    { request_id: "bad-usage", usage: { ...event.usage, status: "missing" } },
    { request_id: "bad-transport", transport: "websocket" },
    { request_id: "bad-model", model: "other" },
    { request_id: "bad-provider", provider_id: "other-provider" },
    { request_id: "diagnostic", diagnostic_code: "upstream_error" },
    { request_id: "observation", observation_issue: "stream_abandoned" },
    { request_id: "missing-response", response_id: null },
    { request_id: "already-successful", outcome: "success" },
    { request_id: "provisional" },
  ]) {
    await ingestUsage(db, { ...event, ...fields });
  }
  await pg.exec(
    "UPDATE requests SET is_provisional = 1 WHERE request_id = 'provisional'",
  );
  const before = await snapshot(pg);
  const result = await pg.exec(sql);
  assert.ok(result.some((item) => item.rows?.[0]?.corrected_requests === 1));
  const after = await snapshot(pg);
  assert.deepEqual(
    after[0],
    before[0].map((row) =>
      row.request_id === exampleId ? { ...row, outcome: "success" } : row,
    ),
  );
  assert.deepEqual(after[1], before[1]);
  assert.deepEqual(
    after[2],
    before[2].map((row) =>
      row.provider_id === event.provider_id && row.model === event.model
        ? {
            ...row,
            success_count: row.success_count + 1,
            cancelled_count: row.cancelled_count - 1,
          }
        : row,
    ),
  );
});

test("PostgreSQL Codex repair aborts on missing or insufficient hourly statistics", async (t) => {
  const { pg } = await fixture(t);
  for (const corrupt of [
    "UPDATE usage_hourly SET cancelled_count = 0",
    "DELETE FROM usage_hourly",
  ]) {
    await pg.exec(corrupt);
    const before = await snapshot(pg);
    await assert.rejects(pg.exec(sql), /missing or inconsistent/);
    await pg.exec("ROLLBACK;");
    assert.deepEqual(await snapshot(pg), before);
  }
});
