import assert from "node:assert/strict";
import type { SqlDatabase } from "../../src/platform/bindings.ts";
import { AGGREGATE_FIELDS } from "../../src/reporting/aggregates.ts";
import {
  expirePendingRequests,
  ingestUsage,
  requestDetail,
} from "../../src/reporting/store.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";
import { usage } from "../admin/fixtures.ts";

/** Compare corrected buckets to independently ingested genuine terminal events. */
export async function checkExpiredUsageCorrection(
  db: SqlDatabase,
): Promise<void> {
  const base = Date.UTC(2026, 8, 14, 10);
  const client = crypto.randomUUID();
  const referenceClient = crypto.randomUUID();
  const finished = {
    ...usage(crypto.randomUUID(), base + 60_000),
    client_id: client,
  };
  const unchanged = {
    ...usage(crypto.randomUUID(), base + 120_000),
    client_id: client,
  };
  await ingestUsage(db, unchanged);
  const pending: UsageEvent = {
    ...finished,
    phase: "started",
    sequence: 1,
    finished_at: null,
    outcome: "pending",
    duration_ms: null,
  };
  await ingestUsage(db, pending);
  await expirePendingRequests(db, 1000, base + 20 * 60_000);
  const expired = await requestDetail(db, finished.request_id);
  assert.equal(expired?.diagnostic_code, "worker_terminated");
  // An out-of-order selection cannot revive a reaped request.
  await ingestUsage(db, pending);
  assert.deepEqual(await requestDetail(db, finished.request_id), expired);

  // The explicit provisional state, not a diagnostic string, authorizes correction.
  await db
    .prepare("UPDATE requests SET event_json = ? WHERE request_id = ?")
    .bind(
      JSON.stringify({
        ...expired,
        diagnostic_code: "renamed_maintenance_diagnostic",
      }),
      finished.request_id,
    )
    .run();
  const beforeCorrection = await requestDetail(db, finished.request_id);
  const beforeRollup = await db
    .prepare("SELECT * FROM usage_hourly WHERE client_id = ?")
    .bind(client)
    .all();
  const failingDb: SqlDatabase = {
    ...db,
    prepare: (sql) => db.prepare(sql),
    batch: (statements) =>
      db.batch([
        ...statements,
        // Fail after the request update and trigger have run, exercising rollback.
        db
          .prepare(
            "INSERT INTO request_attempts (request_id, attempt, duration_ms, event_json) VALUES (?, 1, 0, '{}')",
          )
          .bind(crypto.randomUUID()),
      ]),
  };
  await assert.rejects(ingestUsage(failingDb, finished));
  assert.deepEqual(
    await requestDetail(db, finished.request_id),
    beforeCorrection,
  );
  assert.deepEqual(
    (
      await db
        .prepare("SELECT * FROM usage_hourly WHERE client_id = ?")
        .bind(client)
        .all()
    ).results,
    beforeRollup.results,
  );
  await ingestUsage(db, finished);
  await ingestUsage(db, finished);
  await ingestUsage(db, {
    ...finished,
    outcome: "failed",
    diagnostic_code: "late_duplicate",
  });
  await ingestUsage(db, pending);
  assert.deepEqual(await requestDetail(db, finished.request_id), finished);

  // Routing and currency can differ from the initial checkpoint (including an
  // unselected request). Correction must remove the old bucket completely.
  const moved = {
    ...usage(crypto.randomUUID(), base + 3_600_000 + 60_000, "EUR"),
    client_id: client,
    provider_id: "moved-provider",
  };
  const initial: UsageEvent = {
    ...moved,
    started_at: base + 60_000,
    phase: "started",
    sequence: 0,
    finished_at: null,
    outcome: "pending",
    duration_ms: null,
    provider_id: "unselected-provider",
    credential_id: "",
    model: "",
    first_response_ms: null,
  };
  await ingestUsage(db, initial);
  await expirePendingRequests(db, 1000, base + 2 * 3_600_000);
  await ingestUsage(db, moved);
  await ingestUsage(db, moved);
  assert.deepEqual(await requestDetail(db, moved.request_id), moved);

  // A genuine failure also replaces the provisional failure, including its
  // timings, usage and diagnostic, without becoming eligible for later writes.
  const failed = {
    ...usage(crypto.randomUUID(), base + 120_000),
    client_id: client,
    outcome: "failed" as const,
    diagnostic_code: "upstream_error",
  };
  await ingestUsage(db, {
    ...failed,
    phase: "started",
    sequence: 1,
    finished_at: null,
    outcome: "pending",
    duration_ms: null,
  });
  await expirePendingRequests(db, 1000, base + 2 * 3_600_000);
  await ingestUsage(db, failed);
  await ingestUsage(db, { ...failed, outcome: "success" });
  assert.deepEqual(await requestDetail(db, failed.request_id), failed);

  // Even the same diagnostics cannot make an authoritative event provisional.
  const authoritative: UsageEvent = {
    ...usage(crypto.randomUUID(), base + 120_000),
    client_id: client,
    outcome: "failed",
    diagnostic_code: "worker_terminated",
    observation_issue: "stream_abandoned",
    duration_ms: null,
  };
  await ingestUsage(db, authoritative);
  await ingestUsage(db, { ...authoritative, outcome: "success" });
  assert.deepEqual(
    await requestDetail(db, authoritative.request_id),
    authoritative,
  );

  for (const event of [finished, unchanged, moved, failed, authoritative]) {
    await ingestUsage(db, {
      ...event,
      request_id: crypto.randomUUID(),
      client_id: referenceClient,
    });
  }
  const rollups = async (clientId: string) =>
    (
      await db
        .prepare(
          `SELECT hour, provider_id, credential_id, model, kind, currency, ${AGGREGATE_FIELDS.join(", ")} FROM usage_hourly WHERE client_id = ? ORDER BY hour, provider_id, currency`,
        )
        .bind(clientId)
        .all()
    ).results;
  assert.deepEqual(await rollups(client), await rollups(referenceClient));
}
