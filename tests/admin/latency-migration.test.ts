import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { expect, test } from "vitest";
import { ingestUsage, requestDetail } from "../../src/reporting/store.ts";
import { usage } from "./fixtures.ts";

test("first response migration preserves historical aggregates and accepts older producers", async () => {
  const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
  const db = bindings.CODY_DB;
  const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) =>
    migration.name.startsWith("0003_first_response_latency"),
  );
  expect(migrationIndex).toBeGreaterThan(0);
  await applyD1Migrations(
    db,
    bindings.TEST_MIGRATIONS.slice(0, migrationIndex),
  );
  const legacy = usage("legacy-latency", Date.UTC(2026, 8, 12, 3, 10));
  delete legacy.first_response_ms;
  await db
    .prepare(
      `INSERT INTO requests (
    request_id, event_sequence, started_at, finished_at, endpoint, protocol,
    transport, kind, outcome, usage_status, billing_status, event_json,
    client_id, service_id, key_id, model, currency, ttft_ms, first_text_ms
  ) VALUES (?, 2, ?, ?, 'responses', 'openai', 'sse', 'inference', 'success',
    'reported', 'complete', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      legacy.request_id,
      legacy.started_at,
      legacy.finished_at,
      JSON.stringify(legacy),
      legacy.client_id,
      legacy.service_id,
      legacy.key_id,
      legacy.model,
      legacy.billing.currency,
      legacy.ttft_ms,
      legacy.first_text_ms,
    )
    .run();
  const before = await db.prepare("SELECT * FROM usage_hourly").first();
  expect(before).not.toBeNull();
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  const after = await db.prepare("SELECT * FROM usage_hourly").first();
  expect(after).toEqual({
    ...before,
    first_response_sum: 0,
    first_response_samples: 0,
  });
  expect(await requestDetail(db, legacy.request_id)).toEqual({
    ...legacy,
    first_response_ms: null,
  });

  // A message queued by an older Worker has no new field.
  await ingestUsage(db, { ...legacy, request_id: "legacy-queued" });
  const current = {
    ...legacy,
    request_id: "current-latency",
    first_response_ms: 100,
  };
  await ingestUsage(db, current);
  await ingestUsage(db, current);
  const totals = await db
    .prepare(
      "SELECT requests_count, first_response_sum, first_response_samples FROM usage_hourly",
    )
    .first();
  expect(totals).toEqual({
    requests_count: 3,
    first_response_sum: 100,
    first_response_samples: 1,
  });
});
