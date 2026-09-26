import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import { ingestUsage } from "../src/reporting/store.ts";
import {
  insertStatements,
  sqlTransferEndpoint,
  transferReporting,
} from "../src/reporting/transfer.ts";
import { d1Endpoint, inlineSql, sqlLiteral } from "../scripts/d1-wrangler.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOUR_MS = 3_600_000;
const BASE = Date.UTC(2026, 8, 12, 10);
const NOW = BASE + 3 * 24 * HOUR_MS;
const USAGE_ROWS =
  "SELECT * FROM usage_hourly ORDER BY hour, client_id, provider_id, credential_id, model, kind, currency";
const FINISHED_ROWS =
  "SELECT * FROM requests WHERE finished_at IS NOT NULL ORDER BY request_id";
const ATTEMPT_ROWS =
  "SELECT * FROM request_attempts ORDER BY request_id, attempt";

async function migrated(db) {
  await applyMigrations(db, migrationDirectories(db.dialect, ROOT));
  return db;
}
const sqlite = async (file = ":memory:") =>
  migrated(await createSqliteDatabase(file));
const postgres = async () =>
  migrated(postgresDatabase(pgliteQueryable(new PGlite())));

async function rows(db, sql) {
  return (await db.prepare(sql).all()).results;
}

/** Finished requests over two hours, one in flight and one kept only in its rollup. */
async function seed(db) {
  await ingestUsage(db, usage("req-a", BASE + 60_000));
  await ingestUsage(db, usage("req-b", BASE + 120_000, "EUR"));
  await ingestUsage(db, usage("req-c", BASE + HOUR_MS + 60_000));
  await ingestUsage(db, usage("req-old", BASE - 5 * HOUR_MS));
  await ingestUsage(db, {
    ...usage("req-pending", BASE + 2 * HOUR_MS),
    sequence: 0,
    phase: "started",
    finished_at: null,
    outcome: "pending",
    first_response_ms: null,
  });
  // Request retention deletes requests but keeps their rollups.
  await db.batch([
    db
      .prepare("DELETE FROM request_attempts WHERE request_id = ?")
      .bind("req-old"),
    db.prepare("DELETE FROM requests WHERE request_id = ?").bind("req-old"),
  ]);
}

test("reporting transfer copies finished requests and rollups between dialects", async () => {
  const source = await sqlite();
  await seed(source);
  const target = await postgres();
  const result = await transferReporting(
    sqlTransferEndpoint(source),
    sqlTransferEndpoint(target),
    { now: NOW, pageSize: 2, batchSize: 1 },
  );
  assert.deepEqual(result, {
    requests: 3,
    attempts: 3,
    insertedRequests: 3,
    insertedAttempts: 3,
    adjustments: 1,
    pending: 1,
  });
  const expected = await rows(source, USAGE_ROWS);
  assert.deepEqual(await rows(target, USAGE_ROWS), expected);
  assert.deepEqual(
    await rows(target, FINISHED_ROWS),
    await rows(source, FINISHED_ROWS),
  );
  assert.deepEqual(
    await rows(target, ATTEMPT_ROWS),
    await rows(source, ATTEMPT_ROWS),
  );

  // A rerun only adds what the target lacks, so rollups never double.
  assert.deepEqual(
    await transferReporting(
      sqlTransferEndpoint(source),
      sqlTransferEndpoint(target),
      { now: NOW },
    ),
    { ...result, insertedRequests: 0, insertedAttempts: 0, adjustments: 0 },
  );
  assert.deepEqual(await rows(target, USAGE_ROWS), expected);

  const back = await sqlite();
  await transferReporting(
    sqlTransferEndpoint(target),
    sqlTransferEndpoint(back),
    { now: NOW },
  );
  assert.deepEqual(await rows(back, USAGE_ROWS), expected);
  assert.deepEqual(
    await rows(back, FINISHED_ROWS),
    await rows(source, FINISHED_ROWS),
  );
});

test("reporting transfer limits requests by start time and supports dry runs", async () => {
  const source = await sqlite();
  await seed(source);
  const target = await sqlite();
  const counted = await transferReporting(
    sqlTransferEndpoint(source),
    sqlTransferEndpoint(target),
    { now: NOW, since: BASE + HOUR_MS + 30 * 60_000, dryRun: true },
  );
  assert.deepEqual(counted, {
    requests: 1,
    attempts: 1,
    insertedRequests: null,
    insertedAttempts: null,
    adjustments: 0,
    pending: 1,
  });
  assert.deepEqual(await rows(target, USAGE_ROWS), []);
  assert.deepEqual(await rows(target, FINISHED_ROWS), []);
});

test("D1 endpoints read with d1 execute queries and write with one import", async () => {
  const d1 = new DatabaseSync(":memory:");
  d1.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0001_control_and_usage.sql", "0007_oauth_accounts.sql"])
    d1.exec(await readFile(path.join(ROOT, "migrations", "d1", name), "utf8"));
  const calls = [];
  const run = async (args, { capture }) => {
    calls.push(args);
    if (args.includes("--file")) {
      assert.equal(capture, false);
      d1.exec(await readFile(args[args.indexOf("--file") + 1], "utf8"));
      return "";
    }
    const command = args[args.indexOf("--command") + 1];
    return JSON.stringify(
      command.split(";\n").map((statement) => ({
        success: true,
        results: d1.prepare(statement).all(),
      })),
    );
  };
  const source = await sqlite();
  await seed(source);
  const imports = [];
  const result = await transferReporting(
    sqlTransferEndpoint(source),
    d1Endpoint({
      run,
      confirm: async (size) => {
        imports.push(size);
        return true;
      },
    }),
    { now: NOW },
  );
  assert.equal(result.requests, 3);
  assert.equal(result.insertedRequests, null);
  assert.equal(imports.length, 1);
  assert.ok(
    calls.every(
      (args) => args.slice(0, 4).join(" ") === "d1 execute CODY_DB --remote",
    ),
  );
  assert.equal(calls.filter((args) => args.includes("--file")).length, 1);
  assert.ok(calls.at(-1).includes("--yes"));
  const expected = await rows(source, USAGE_ROWS);
  assert.deepEqual(
    d1
      .prepare(USAGE_ROWS)
      .all()
      .map((row) => ({ ...row })),
    expected,
  );

  const copy = await sqlite();
  // Reads retry transient failures, such as Wrangler's "fetch failed".
  let reads = 0;
  const flaky = async (args, options) => {
    reads += 1;
    if (reads % 2 === 1) throw new Error("fetch failed");
    return run(args, options);
  };
  const back = await transferReporting(
    d1Endpoint({ run: flaky, retryDelayMs: 0 }),
    sqlTransferEndpoint(copy),
    { now: NOW, pageSize: 2 },
  );
  assert.equal(back.insertedRequests, 3);
  assert.deepEqual(await rows(copy, USAGE_ROWS), expected);
  assert.deepEqual(
    await rows(copy, ATTEMPT_ROWS),
    await rows(source, ATTEMPT_ROWS),
  );
  await assert.rejects(
    d1Endpoint({
      run: async () => {
        throw new Error("fetch failed");
      },
      attempts: 2,
      retryDelayMs: 0,
    }).read([{ sql: "SELECT 1", values: [] }]),
    /fetch failed/,
  );

  await assert.rejects(
    transferReporting(
      sqlTransferEndpoint(source),
      d1Endpoint({ run, database: "other", confirm: async () => false }),
      { now: NOW, since: BASE },
    ),
    /cancelled/,
  );
});

test("D1 statements inline literals within the statement size limit", () => {
  assert.equal(
    inlineSql("SELECT ?, '?', ?, ?", ["it's", null, 12.5]),
    "SELECT 'it''s', '?', NULL, 12.5",
  );
  assert.equal(sqlLiteral(10n), "10");
  assert.throws(() => sqlLiteral(Number.NaN), /finite/);
  assert.throws(() => inlineSql("SELECT ?", []), /Missing/);
  assert.throws(() => inlineSql("SELECT 1", [1]), /Unused/);

  const table = Array.from({ length: 10 }, (_, index) => ({
    id: `row-${index}`,
    note: "x".repeat(40),
  }));
  const conflict = "ON CONFLICT (id) DO NOTHING";
  const limited = insertStatements("t", ["id", "note"], table, conflict, {
    bytes: 250,
    values: 100,
  });
  assert.ok(limited.length > 1);
  assert.equal(
    limited.reduce((count, statement) => count + statement.values.length, 0),
    20,
  );
  for (const statement of limited)
    assert.ok(inlineSql(statement.sql, statement.values).length <= 250);
  assert.equal(
    insertStatements("t", ["id", "note"], table, conflict, {
      bytes: 1e6,
      values: 4,
    }).length,
    5,
  );
  assert.throws(
    () =>
      insertStatements(
        "t",
        ["id", "note"],
        [{ id: "large", note: "x".repeat(300) }],
        conflict,
        { bytes: 250, values: 100 },
      ),
    /too large/,
  );
});

test("reporting:transfer copies between database URLs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cody-transfer-"));
  try {
    const from = `sqlite:${path.join(directory, "source.sqlite")}`;
    const to = `sqlite:${path.join(directory, "target.sqlite")}`;
    const source = await sqlite(from.slice("sqlite:".length));
    await seed(source);
    const target = await sqlite(to.slice("sqlite:".length));
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/transfer-reporting.mjs",
        "--from",
        from,
        "--to",
        to,
      ],
      { cwd: ROOT, env },
    );
    assert.match(stdout, /^Requests: 3, 3 new$/m);
    assert.match(stdout, /^Attempts: 3, 3 new$/m);
    assert.match(stdout, /^In-flight requests left for a later run: 1$/m);
    assert.deepEqual(
      await rows(target, USAGE_ROWS),
      await rows(source, USAGE_ROWS),
    );
    source.close();
    target.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
