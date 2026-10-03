import assert from "node:assert/strict";
import type { SqlDatabase } from "../../src/platform/bindings.ts";

export const retiredConfigurationTables = [
  "control_state",
  "config_revisions",
  "pricing_versions",
  "oauth_clients",
  "configuration_migrations",
  "configuration_id_map",
  "configuration_migration_archive",
];
export async function configurationTables(db: SqlDatabase) {
  const query =
    db.dialect === "postgres"
      ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'"
      : "SELECT name FROM sqlite_master WHERE type = 'table'";
  return new Set(
    (await db.prepare(query).all<{ name: string }>()).results.map(
      (row) => row.name,
    ),
  );
}

/** Entity initialization retires document stores without discarding reporting or OAuth history. */
export async function checkConfigurationCleanup(
  db: SqlDatabase,
  apply: () => Promise<unknown>,
) {
  await db.batch([
    db.prepare(
      "INSERT INTO config_revisions (id, payload, created_at, actor, status) VALUES (1, 'retired-encrypted-document', 0, 'test', 'published')",
    ),
    db.prepare(
      "UPDATE control_state SET draft_payload = 'retired-encrypted-document', published_revision = 1 WHERE id = 1",
    ),
    db.prepare(
      "INSERT INTO pricing_versions (id, revision, provider_id, model, policy_json, created_at) VALUES ('retired-price', 1, 'retired-provider', 'model', '{}', 0)",
    ),
    db.prepare(
      "INSERT INTO oauth_clients (provider_type, payload, version, updated_at) VALUES ('antigravity', 'retired-registration', 1, 0)",
    ),
  ]);
  // A failed DROP must roll back the new schema and every preceding DROP together.
  await db
    .prepare(
      "CREATE TABLE cleanup_dependency (revision INTEGER REFERENCES config_revisions(id))",
    )
    .run();
  await db
    .prepare("INSERT INTO cleanup_dependency (revision) VALUES (1)")
    .run();
  await assert.rejects(apply);
  const rolledBack = await configurationTables(db);
  for (const table of [
    "control_state",
    "config_revisions",
    "pricing_versions",
    "oauth_clients",
  ])
    assert.ok(rolledBack.has(table), table);
  assert.ok(!rolledBack.has("config_meta"));
  await db.prepare("DROP TABLE cleanup_dependency").run();

  await db.batch([
    db.prepare(
      "INSERT INTO requests (request_id, event_sequence, started_at, finished_at, endpoint, protocol, transport, outcome, usage_status, billing_status, event_json) VALUES ('retained', 2, 7200000, 7200001, 'responses', 'openai', 'http', 'success', 'reported', 'complete', '{\"diagnostic_code\":\"historical\"}')",
    ),
    db.prepare(
      "INSERT INTO request_attempts (request_id, attempt, status, duration_ms, event_json) VALUES ('retained', 1, 200, 1, '{\"provider_id\":\"retired-provider\"}')",
    ),
    db.prepare(
      "INSERT INTO audit_log (id, created_at, actor, action, revision) VALUES ('retained', 0, 'test', 'publish', 1)",
    ),
    db.prepare(
      "INSERT INTO usage_hourly (hour, client_id, provider_id, credential_id, model, kind, currency, requests_count, cost_nano) VALUES (0, 'retired-client', 'retired-provider', 'retired-credential', 'old-model', 'inference', 'USD', 7, 123)",
    ),
    db
      .prepare(
        "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, 'antigravity', 0)",
      )
      .bind(crypto.randomUUID(), crypto.randomUUID()),
  ]);
  const retained = [
    "audit_log",
    "oauth_accounts",
    "requests",
    "request_attempts",
    "usage_hourly",
  ];
  const readRetained = async () =>
    Promise.all(
      retained.map(async (table) => {
        const rows = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
        return {
          table,
          rows: rows
            .map((row) =>
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(row).map(([key, value]) => [
                    key === "event_json" ? "details_json" : key,
                    value,
                  ]),
                ),
              ),
            )
            .sort(),
        };
      }),
    );
  const before = await readRetained();
  await apply();
  const remaining = await configurationTables(db);
  for (const table of retiredConfigurationTables)
    assert.ok(!remaining.has(table), table);
  assert.deepEqual(await readRetained(), before);
  assert.equal(
    (
      await db
        .prepare("SELECT version FROM config_meta WHERE id = 1")
        .first<{ version: number }>()
    )?.version,
    0,
  );
}
