/**
 * Copies request history (requests, their attempts and hourly rollups)
 * between reporting databases: D1, SQLite, libSQL or PostgreSQL. Only
 * finished requests move; in-flight ones stay behind because the target's
 * maintenance would reap them as failed. Rows the target already holds are
 * skipped and the target's rollup triggers count every inserted request once,
 * so repeating a transfer tops the target up without double counting.
 *
 * Request retention deletes old requests but keeps their rollups. For settled
 * hours, the part of a source rollup that its remaining requests no longer
 * explain moves as an adjustment the first time that rollup reaches the
 * target, before any of its requests, so a rerun never adds it twice.
 */
import { sqlDialect, type SqlDatabase } from "../platform/bindings.ts";
import { AGGREGATE_FIELDS } from "./aggregates.ts";
import { HOUR_MS } from "./ranges.ts";
import { AGGREGATE_EXPRESSIONS } from "./store.ts";

export type SqlValue = string | number | bigint | null;

export interface SqlCommand {
  readonly sql: string;
  readonly values: readonly SqlValue[];
}

type Row = Record<string, unknown>;

/** A reporting database that a transfer reads from. */
export interface TransferSource {
  /** Runs read-only queries in order and resolves each query's rows. */
  read(queries: readonly SqlCommand[]): Promise<Row[][]>;
}

export interface StatementLimits {
  /** Largest statement with its values inlined, in UTF-8 bytes. */
  readonly bytes: number;
  /** Most bound values in one statement. */
  readonly values: number;
}

/** A reporting database that a transfer writes to. */
export interface TransferTarget extends TransferSource {
  readonly limits: StatementLimits;
  /**
   * Applies the commands atomically and resolves each command's inserted row
   * count, or null when the target defers its writes until `commit`.
   */
  write(commands: readonly SqlCommand[]): Promise<number[] | null>;
  commit?(): Promise<void>;
}

export interface TransferOptions {
  /** Copies requests started at or after this time, rounded down to the hour. */
  readonly since?: number;
  readonly now?: number;
  /** Requests read per source query. */
  readonly pageSize?: number;
  /** Requests written per atomic target batch. */
  readonly batchSize?: number;
  /** Reads and counts without writing. */
  readonly dryRun?: boolean;
  readonly onProgress?: (requests: number) => void;
}

export interface TransferResult {
  /** Finished source requests and their attempts. */
  readonly requests: number;
  readonly attempts: number;
  /** Rows the target did not hold yet; null for dry runs and deferred writes. */
  readonly insertedRequests: number | null;
  readonly insertedAttempts: number | null;
  /** Settled rollups copied for requests the source no longer keeps. */
  readonly adjustments: number;
  /** In-flight source requests left for a later transfer. */
  readonly pending: number;
}

const ROLLUP_KEY = [
  "hour",
  "client_id",
  "provider_id",
  "credential_id",
  "model",
  "kind",
  "currency",
] as const;
const ROLLUP_COLUMNS = [...ROLLUP_KEY, ...AGGREGATE_FIELDS];
/** Real-valued sums, whose last bits depend on the summation order. */
const SUMS = new Set<string>([
  "duration_sum",
  "first_response_sum",
  "ttft_sum",
  "first_text_sum",
]);
/** Late usage deliveries and pending-request reaping settle well within a day. */
const SETTLED_MS = 24 * HOUR_MS;

const PENDING =
  "SELECT COUNT(*) AS count FROM requests WHERE finished_at IS NULL AND started_at >= ?";
const ROLLUPS = `SELECT ${ROLLUP_COLUMNS.join(", ")} FROM usage_hourly WHERE hour >= ? AND hour < ?`;
const RECOMPUTED = `SELECT (started_at / ${HOUR_MS}) * ${HOUR_MS} AS hour, client_id, provider_id, credential_id, model, kind, currency, ${AGGREGATE_FIELDS.map(
  (field) =>
    `SUM(${AGGREGATE_EXPRESSIONS[field].replaceAll("NEW.", "")}) AS ${field}`,
).join(", ")}
  FROM requests WHERE finished_at IS NOT NULL AND started_at >= ? AND started_at < ?
  GROUP BY 1, 2, 3, 4, 5, 6, 7`;
const TARGET_ROLLUPS = `SELECT ${ROLLUP_KEY.join(", ")} FROM usage_hourly WHERE hour >= ? AND hour <= ?`;
// Keyset pages over (started_at, request_id); the attempts query bounds the
// same page by its last row, so both queries use short statements.
const PAGE = `SELECT * FROM requests
  WHERE finished_at IS NOT NULL AND started_at >= ?
    AND (started_at > ? OR (started_at = ? AND request_id > ?))
  ORDER BY started_at, request_id LIMIT ?`;
const PAGE_ATTEMPTS = `SELECT a.* FROM request_attempts a
  JOIN requests r ON r.request_id = a.request_id
  WHERE r.finished_at IS NOT NULL AND r.started_at >= ?
    AND (r.started_at > ? OR (r.started_at = ? AND r.request_id > ?))
    AND (r.started_at < ? OR (r.started_at = ? AND r.request_id <= ?))
  ORDER BY a.request_id, a.attempt`;
const ADJUST_ROLLUP = `ON CONFLICT (${ROLLUP_KEY.join(", ")}) DO UPDATE SET ${AGGREGATE_FIELDS.map(
  (field) => `${field} = usage_hourly.${field} + excluded.${field}`,
).join(", ")}`;

const encoder = new TextEncoder();

function sqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  )
    return value;
  throw new TypeError(`Unsupported reporting value of type ${typeof value}`);
}

/** Bytes a value occupies as an inlined SQL literal. */
function literalBytes(value: SqlValue): number {
  if (value === null) return 4;
  if (typeof value !== "string") return String(value).length;
  return encoder.encode(value).byteLength + value.split("'").length + 1;
}

/** Multi-row INSERT statements that each fit the target's statement limits. */
export function insertStatements(
  table: string,
  columns: readonly string[],
  rows: readonly Row[],
  conflict: string,
  limits: StatementLimits,
): SqlCommand[] {
  const head = `INSERT INTO ${table} (${columns.join(", ")}) VALUES `;
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const fixed = head.length + conflict.length + 1;
  const statements: SqlCommand[] = [];
  let values: SqlValue[] = [];
  let count = 0;
  let bytes = fixed;
  const flush = () => {
    if (count === 0) return;
    statements.push({
      sql: `${head}${Array.from({ length: count }, () => tuple).join(", ")} ${conflict}`,
      values,
    });
    values = [];
    count = 0;
    bytes = fixed;
  };
  for (const row of rows) {
    const next = columns.map((column) => sqlValue(row[column]));
    // Each value also takes a separator; each tuple its parentheses.
    const size = next.reduce<number>(
      (total, value) => total + literalBytes(value) + 2,
      4,
    );
    if (fixed + size > limits.bytes || next.length > limits.values)
      throw new Error(`A ${table} row is too large for one target statement`);
    if (
      bytes + size > limits.bytes ||
      values.length + next.length > limits.values
    )
      flush();
    values.push(...next);
    bytes += size;
    count += 1;
  }
  flush();
  return statements;
}

function rollupKey(row: Row): string {
  return JSON.stringify([
    Number(row.hour),
    ...ROLLUP_KEY.slice(1).map((column) => String(row[column])),
  ]);
}

/** The part of each source rollup that its remaining requests do not explain. */
export function rollupAdjustments(
  rollups: readonly Row[],
  recomputed: readonly Row[],
): Row[] {
  const explained = new Map(recomputed.map((row) => [rollupKey(row), row]));
  const adjustments: Row[] = [];
  const compare = (rollup: Row | undefined, aggregate: Row | undefined) => {
    const key = (rollup ?? aggregate)!;
    const adjustment: Row = Object.fromEntries(
      ROLLUP_KEY.map((column) => [column, key[column]]),
    );
    let changed = false;
    for (const field of AGGREGATE_FIELDS) {
      const kept = Number(rollup?.[field] ?? 0);
      const delta = kept - Number(aggregate?.[field] ?? 0);
      adjustment[field] = delta;
      if (
        SUMS.has(field)
          ? Math.abs(delta) > 1e-6 * Math.max(1, Math.abs(kept))
          : delta !== 0
      )
        changed = true;
    }
    if (changed) adjustments.push(adjustment);
  };
  for (const rollup of rollups) {
    const key = rollupKey(rollup);
    compare(rollup, explained.get(key));
    explained.delete(key);
  }
  for (const aggregate of explained.values()) compare(undefined, aggregate);
  return adjustments;
}

const total = (counts: readonly number[]): number =>
  counts.reduce((sum, count) => sum + count, 0);

export async function transferReporting(
  source: TransferSource,
  target: TransferTarget,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const since = Math.floor(Math.max(0, options.since ?? 0) / HOUR_MS) * HOUR_MS;
  const settled =
    Math.floor(((options.now ?? Date.now()) - SETTLED_MS) / HOUR_MS) * HOUR_MS;
  const pageSize = options.pageSize ?? 1000;
  const batchSize = options.batchSize ?? 250;
  const write = (commands: SqlCommand[]) =>
    options.dryRun ? Promise.resolve(null) : target.write(commands);

  const [[pending] = [], rollups = [], recomputed = []] = await source.read([
    { sql: PENDING, values: [since] },
    ...(since < settled
      ? [
          { sql: ROLLUPS, values: [since, settled] },
          { sql: RECOMPUTED, values: [since, settled] },
        ]
      : []),
  ]);
  let adjustments = rollupAdjustments(rollups, recomputed);
  if (adjustments.length > 0) {
    const hours = adjustments.map((row) => Number(row.hour));
    const [present = []] = await target.read([
      {
        sql: TARGET_ROLLUPS,
        values: [
          hours.reduce((a, b) => Math.min(a, b)),
          hours.reduce((a, b) => Math.max(a, b)),
        ],
      },
    ]);
    const existing = new Set(present.map(rollupKey));
    adjustments = adjustments.filter((row) => !existing.has(rollupKey(row)));
  }
  if (adjustments.length > 0)
    await write(
      insertStatements(
        "usage_hourly",
        ROLLUP_COLUMNS,
        adjustments,
        ADJUST_ROLLUP,
        target.limits,
      ),
    );

  let requests = 0;
  let attempts = 0;
  let insertedRequests: number | null = options.dryRun ? null : 0;
  let insertedAttempts: number | null = insertedRequests;
  let cursor: [number, string] = [since - 1, ""];
  for (;;) {
    const [page = []] = await source.read([
      { sql: PAGE, values: [since, cursor[0], cursor[0], cursor[1], pageSize] },
    ]);
    if (page.length === 0) break;
    const last = page[page.length - 1]!;
    const end: [number, string] = [
      Number(last.started_at),
      String(last.request_id),
    ];
    const [pageAttempts = []] = await source.read([
      {
        sql: PAGE_ATTEMPTS,
        values: [
          since,
          cursor[0],
          cursor[0],
          cursor[1],
          end[0],
          end[0],
          end[1],
        ],
      },
    ]);
    // Requests that finished after the page was read fall inside its bounds
    // too; their attempts wait for the next transfer with their request.
    const byRequest = new Map<string, Row[]>();
    for (const attempt of pageAttempts) {
      const id = String(attempt.request_id);
      const list = byRequest.get(id);
      if (list) list.push(attempt);
      else byRequest.set(id, [attempt]);
    }
    for (let offset = 0; offset < page.length; offset += batchSize) {
      const batch = page.slice(offset, offset + batchSize);
      const batchAttempts = batch.flatMap(
        (row) => byRequest.get(String(row.request_id)) ?? [],
      );
      attempts += batchAttempts.length;
      const requestStatements = insertStatements(
        "requests",
        Object.keys(batch[0]!),
        batch,
        "ON CONFLICT (request_id) DO NOTHING",
        target.limits,
      );
      const attemptStatements =
        batchAttempts.length > 0
          ? insertStatements(
              "request_attempts",
              Object.keys(batchAttempts[0]!),
              batchAttempts,
              "ON CONFLICT (request_id, attempt) DO NOTHING",
              target.limits,
            )
          : [];
      const changes = await write([...requestStatements, ...attemptStatements]);
      if (changes === null) {
        insertedRequests = null;
        insertedAttempts = null;
      } else if (insertedRequests !== null && insertedAttempts !== null) {
        insertedRequests += total(changes.slice(0, requestStatements.length));
        insertedAttempts += total(changes.slice(requestStatements.length));
      }
    }
    requests += page.length;
    options.onProgress?.(requests);
    cursor = end;
    if (page.length < pageSize) break;
  }
  if (!options.dryRun) await target.commit?.();
  return {
    requests,
    attempts,
    insertedRequests,
    insertedAttempts,
    adjustments: adjustments.length,
    pending: Number(pending?.count ?? 0),
  };
}

/** A standard-backend database (SQLite, libSQL or PostgreSQL) as an endpoint. */
export function sqlTransferEndpoint(db: SqlDatabase): TransferTarget {
  return {
    // Parameter limits of SQLite and PostgreSQL; statements also stay small
    // enough for one libSQL HTTP request.
    limits: {
      bytes: 1 << 20,
      values: sqlDialect(db) === "postgres" ? 65_535 : 32_766,
    },
    async read(queries) {
      const results: Row[][] = [];
      for (const query of queries) {
        const { results: rows } = await db
          .prepare(query.sql)
          .bind(...query.values)
          .all();
        results.push(rows);
      }
      return results;
    },
    async write(commands) {
      const results = await db.batch(
        commands.map((command) =>
          db.prepare(command.sql).bind(...command.values),
        ),
      );
      return results.map((result) => result.meta.changes);
    },
  };
}
