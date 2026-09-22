import {
  HOUR_MS,
  previousRange,
  reportBucketMs,
  type ReportRange,
} from "./ranges.ts";
import type { UsageEvent } from "../telemetry/types.ts";
import { USAGE_FIELDS } from "../billing/types.ts";
import type { ReportQuery } from "./query.ts";
import {
  AGGREGATE_FIELDS,
  defaultCurrency,
  summarize,
  type Aggregate,
  type Rollup,
  type SeriesRow,
} from "./aggregates.ts";

export type { SeriesRow } from "./aggregates.ts";
export interface ReportFilters {
  provider_id?: string;
  credential_id?: string;
  client_id?: string;
  model?: string;
  currency?: string;
}
export interface ReportPresentation {
  group_by?: ReportQuery["group_by"];
  sort_by?: ReportQuery["sort_by"];
  cost_currency?: string;
  compare?: boolean;
}
interface RankRow extends Aggregate {
  value: string;
  currency: string;
}
interface PendingRow {
  count: number;
}

const AGGREGATE_EXPRESSIONS = {
  requests_count: "1",
  success_count: "CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END",
  failed_count: "CASE WHEN NEW.outcome = 'failed' THEN 1 ELSE 0 END",
  cancelled_count: "CASE WHEN NEW.outcome = 'cancelled' THEN 1 ELSE 0 END",
  incomplete_count: "CASE WHEN NEW.outcome = 'incomplete' THEN 1 ELSE 0 END",
  missing_usage_count:
    "CASE WHEN NEW.kind = 'inference' AND NEW.usage_status <> 'reported' THEN 1 ELSE 0 END",
  unpriced_count:
    "CASE WHEN NEW.kind = 'inference' AND NEW.billing_status <> 'complete' THEN 1 ELSE 0 END",
  input_tokens: "COALESCE(NEW.input_tokens, 0)",
  uncached_input_tokens: "COALESCE(NEW.uncached_input_tokens, 0)",
  output_tokens: "COALESCE(NEW.output_tokens, 0)",
  cache_read_tokens: "COALESCE(NEW.cache_read_tokens, 0)",
  cache_write_tokens: "COALESCE(NEW.cache_write_tokens, 0)",
  cache_write_5m_tokens: "COALESCE(NEW.cache_write_5m_tokens, 0)",
  cache_write_1h_tokens: "COALESCE(NEW.cache_write_1h_tokens, 0)",
  reasoning_tokens: "COALESCE(NEW.reasoning_tokens, 0)",
  reasoning_samples: "CASE WHEN NEW.reasoning_tokens IS NULL THEN 0 ELSE 1 END",
  cost_nano: "COALESCE(NEW.cost_nano, 0)",
  duration_sum: "COALESCE(NEW.duration_ms, 0)",
  duration_samples: "CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END",
  first_response_sum: "COALESCE(NEW.first_response_ms, 0)",
  first_response_samples:
    "CASE WHEN NEW.first_response_ms IS NULL THEN 0 ELSE 1 END",
  ttft_sum: "COALESCE(NEW.ttft_ms, 0)",
  ttft_samples: "CASE WHEN NEW.ttft_ms IS NULL THEN 0 ELSE 1 END",
  first_text_sum: "COALESCE(NEW.first_text_ms, 0)",
  first_text_samples: "CASE WHEN NEW.first_text_ms IS NULL THEN 0 ELSE 1 END",
} as const;
const FILTER_FIELDS = [
  "provider_id",
  "credential_id",
  "client_id",
  "model",
  "currency",
] as const;

function conditions(filters: ReportFilters): { sql: string; values: string[] } {
  const clauses = ["kind = 'inference'"];
  const values: string[] = [];
  for (const field of FILTER_FIELDS) {
    const value = filters[field];
    if (value) {
      clauses.push(`${field} = ?`);
      values.push(value);
    }
  }
  return { sql: ` AND ${clauses.join(" AND ")}`, values };
}

function firstResponseLatency(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid first response latency");
  }
  return value;
}

export async function ingestUsage(
  db: D1Database,
  event: UsageEvent,
): Promise<void> {
  if (event.kind !== "inference") return;
  if (
    event.schema_version !== 2 ||
    !["started", "finished"].includes(event.phase) ||
    typeof event.request_id !== "string" ||
    !event.request_id ||
    !Number.isSafeInteger(event.started_at) ||
    ![0, 1, 2].includes(event.sequence) ||
    (event.phase === "finished") !== (event.finished_at !== null) ||
    (event.phase === "finished") !== (event.sequence === 2)
  ) {
    throw new Error("Invalid usage event envelope");
  }
  const firstResponseMs = firstResponseLatency(event.first_response_ms);
  const columns = [
    "request_id",
    "event_sequence",
    "started_at",
    "finished_at",
    "client_id",
    "provider_id",
    "credential_id",
    "model",
    "kind",
    "currency",
    "requested_model",
    "endpoint",
    "protocol",
    "transport",
    "outcome",
    "http_status",
    "duration_ms",
    "first_response_ms",
    "ttft_ms",
    "first_text_ms",
    "context_tokens",
    "context_window",
    ...USAGE_FIELDS,
    "usage_status",
    "billing_status",
    "cost_nano",
    "event_json",
  ];
  const values = [
    event.request_id,
    event.sequence,
    event.started_at,
    event.finished_at,
    event.client_id,
    event.provider_id,
    event.credential_id,
    event.model,
    event.kind,
    event.billing.currency,
    event.requested_model,
    event.endpoint,
    event.protocol,
    event.transport,
    event.outcome,
    event.http_status,
    event.duration_ms,
    firstResponseMs,
    event.ttft_ms,
    event.first_text_ms,
    event.context_tokens,
    event.context_window,
    ...USAGE_FIELDS.map((field) => event.usage.tokens[field]),
    event.usage.status,
    event.billing.status,
    event.billing.total_nano,
    JSON.stringify({
      ...event,
      first_response_ms: firstResponseMs,
    }),
  ];
  const statements = [
    db
      .prepare(
        `INSERT INTO requests (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
      ON CONFLICT(request_id) DO UPDATE SET ${columns
        .slice(1)
        .map((column) => `${column} = excluded.${column}`)
        .join(",")}
      WHERE excluded.event_sequence > requests.event_sequence`,
      )
      .bind(...values),
  ];
  if (event.phase === "finished") {
    for (const attempt of event.attempts) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO request_attempts (request_id, attempt, status, duration_ms, event_json) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            event.request_id,
            attempt.attempt,
            attempt.status,
            attempt.duration_ms,
            JSON.stringify(attempt),
          ),
      );
    }
  }
  // The request transition, SQL-triggered rollup, and attempt inserts commit together.
  await db.batch(statements);
}

function reportSource(range: ReportRange, filters: ReportFilters) {
  const fullStart = Math.ceil(range.from / HOUR_MS) * HOUR_MS;
  const fullEnd = Math.max(fullStart, Math.floor(range.to / HOUR_MS) * HOUR_MS);
  const filter = conditions(filters);
  const columns = AGGREGATE_FIELDS.join(", ");
  const edgeExpressions = AGGREGATE_FIELDS.map(
    (field) =>
      `${AGGREGATE_EXPRESSIONS[field].replaceAll("NEW.", "")} AS ${field}`,
  ).join(", ");
  const queries = [
    `SELECT hour, currency, provider_id, credential_id, client_id, model, kind, ${columns}
     FROM usage_hourly WHERE hour >= ? AND hour < ? ${filter.sql}`,
  ];
  const values: (string | number)[] = [fullStart, fullEnd, ...filter.values];
  const edges =
    fullStart === fullEnd
      ? [range]
      : [
          { from: range.from, to: fullStart },
          { from: fullEnd, to: range.to },
        ];
  // Bound each edge independently so the time index skips every full hour.
  // Filtering a whole-range detail query with NOT still scans those requests.
  for (const { from, to } of edges) {
    if (from >= to) continue;
    queries.push(
      `SELECT (started_at / ${HOUR_MS}) * ${HOUR_MS} AS hour, currency,
         provider_id, credential_id, client_id, model, kind, ${edgeExpressions}
       FROM requests WHERE finished_at IS NOT NULL
         AND started_at >= ? AND started_at < ? ${filter.sql}`,
    );
    values.push(from, to, ...filter.values);
  }
  return { sql: queries.join(" UNION ALL "), values };
}

const sumColumns = AGGREGATE_FIELDS.map(
  (field) => `SUM(${field}) AS ${field}`,
).join(", ");

function seriesQuery(
  db: D1Database,
  range: ReportRange,
  filters: ReportFilters,
  bucketMs: number,
) {
  const source = reportSource(range, filters);
  return db
    .prepare(
      `SELECT (hour / ${bucketMs}) * ${bucketMs} AS hour, currency, ${sumColumns}
     FROM (${source.sql}) GROUP BY 1, 2 ORDER BY 1, 2`,
    )
    .bind(...source.values);
}

function rankQuery(
  db: D1Database,
  range: ReportRange,
  filters: ReportFilters,
  presentation: ReportPresentation,
) {
  const source = reportSource(range, filters);
  const dimension = presentation.group_by ?? "provider_id";
  const metric = presentation.sort_by ?? "requests";
  const score =
    metric === "cost"
      ? "SUM(CASE WHEN currency = COALESCE(?, (SELECT currency FROM source WHERE currency <> '' GROUP BY currency ORDER BY currency = 'USD' DESC, currency LIMIT 1)) THEN cost_nano ELSE 0 END)"
      : metric === "tokens"
        ? "SUM(input_tokens + output_tokens)"
        : "SUM(requests_count)";
  const query = db.prepare(
    `WITH source AS (${source.sql}),
     grouped AS (SELECT ${dimension} AS value, currency, ${sumColumns} FROM source GROUP BY ${dimension}, currency),
     leaders AS (SELECT value, ${score} AS score FROM grouped GROUP BY value ORDER BY score DESC, value LIMIT 5)
     SELECT grouped.* FROM grouped JOIN leaders ON grouped.value = leaders.value
     ORDER BY leaders.score DESC, grouped.value, grouped.currency`,
  );
  return query.bind(
    ...source.values,
    ...(metric === "cost" ? [presentation.cost_currency ?? null] : []),
  );
}

function ranking(rows: RankRow[], total: Rollup) {
  const groups = new Map<string, RankRow[]>();
  for (const row of rows) {
    const group = groups.get(row.value) ?? [];
    group.push(row);
    groups.set(row.value, group);
  }
  const items = [...groups].map(([value, group]) => ({
    value,
    ...summarize(group),
  }));
  const visible = summarize(rows);
  const other = structuredClone(total);
  for (const field of AGGREGATE_FIELDS)
    other.totals[field] -= visible.totals[field];
  for (const [currency, amount] of Object.entries(other.currencies)) {
    const selected = visible.currencies[currency];
    if (selected) {
      amount.cost_nano -= selected.cost_nano;
      amount.requests_count -= selected.requests_count;
      amount.unpriced_count -= selected.unpriced_count;
    }
    if (!amount.requests_count) delete other.currencies[currency];
  }
  return { items, other: other.totals.requests_count ? other : null };
}

export async function summary(
  db: D1Database,
  range: ReportRange,
  filters: ReportFilters,
  presentation: ReportPresentation = {},
) {
  const bucketMs = reportBucketMs(range);
  const comparison =
    presentation.compare === false ? null : previousRange(range);
  const filter = conditions(filters);
  const statements = [
    seriesQuery(db, range, filters, bucketMs),
    rankQuery(db, range, filters, presentation),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM requests WHERE finished_at IS NULL AND started_at >= ? AND started_at < ? ${filter.sql}`,
      )
      .bind(range.from, range.to, ...filter.values),
  ];
  if (comparison)
    statements.push(seriesQuery(db, comparison, filters, bucketMs));
  // Keep totals, ranking and comparison in one D1 transaction while usage arrives.
  const [currentResult, rankResult, pendingResult, previousResult] =
    await db.batch<SeriesRow | RankRow | PendingRow>(statements);
  // D1 preserves statement order but its batch generic cannot describe a
  // different row type per statement. These types match the SELECTs above.
  const series = currentResult.results as SeriesRow[];
  const total = summarize(series);
  const previous = previousResult?.results as SeriesRow[] | undefined;
  const pending = pendingResult.results as PendingRow[];
  return {
    range,
    ...total,
    bucket_ms: bucketMs,
    pending: pending[0]?.count ?? 0,
    series,
    previous:
      comparison && previous
        ? {
            range: comparison,
            ...summarize(previous),
            series: previous,
            bucket_ms: bucketMs,
          }
        : null,
    ranking: {
      dimension: presentation.group_by ?? "provider_id",
      metric: presentation.sort_by ?? "requests",
      currency: presentation.cost_currency ?? defaultCurrency(total.currencies),
      ...ranking(rankResult.results as RankRow[], total),
    },
    updated_at: Date.now(),
  };
}

/** Include historic IDs from the selected window, even after configuration changes. */
export async function reportDimensions(
  db: D1Database,
  range: ReportRange,
  providerId?: string,
) {
  const fields = ["provider_id", "model", "client_id"] as const;
  const statements = fields.map((field) => {
    const selected = field === "model" && providerId ? [providerId] : [];
    const provider = selected.length ? " AND provider_id = ?" : "";
    return db
      .prepare(
        `SELECT DISTINCT ${field} AS value FROM (
        SELECT ${field} FROM usage_hourly WHERE kind = 'inference' AND hour >= ? AND hour < ? ${provider}
        UNION ALL SELECT ${field} FROM requests WHERE kind = 'inference' AND finished_at IS NULL AND started_at >= ? AND started_at < ? ${provider}
      ) WHERE ${field} <> '' ORDER BY value`,
      )
      .bind(
        Math.floor(range.from / HOUR_MS) * HOUR_MS,
        range.to,
        ...selected,
        range.from,
        range.to,
        ...selected,
      );
  });
  const result = await db.batch<{ value: string }>(statements);
  return {
    providers: result[0].results.map((row) => row.value),
    models: result[1].results.map((row) => row.value),
    clients: result[2].results.map((row) => row.value),
  };
}

function parseUsageEvent(json: string): UsageEvent {
  // These rows contain UsageEvents serialized by ingestUsage. Older rows
  // written before first-response metering omit the new field.
  const event = JSON.parse(json) as UsageEvent;
  event.first_response_ms = firstResponseLatency(event.first_response_ms);
  return event;
}

export async function requestList(
  db: D1Database,
  range: ReportRange,
  filters: ReportFilters,
  options: {
    limit: number;
    cursor?: string;
    outcome?: ReportQuery["outcome"];
    quality?: ReportQuery["quality"];
  },
) {
  const filter = conditions(filters);
  let cursorSql = "";
  const extra: (string | number)[] = [];
  if (options.quality) {
    cursorSql +=
      options.quality === "missing_usage"
        ? " AND finished_at IS NOT NULL AND kind = 'inference' AND usage_status <> 'reported'"
        : " AND finished_at IS NOT NULL AND kind = 'inference' AND billing_status <> 'complete'";
  }
  if (options.outcome) {
    cursorSql += " AND outcome = ?";
    extra.push(options.outcome);
  }
  if (options.cursor) {
    let cursor: unknown;
    try {
      cursor = JSON.parse(atob(options.cursor));
    } catch {
      throw new Error("Invalid cursor");
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 2 ||
      typeof cursor[0] !== "number" ||
      !Number.isSafeInteger(cursor[0]) ||
      typeof cursor[1] !== "string"
    )
      throw new Error("Invalid cursor");
    cursorSql += " AND (started_at < ? OR (started_at = ? AND request_id < ?))";
    extra.push(cursor[0], cursor[0], cursor[1]);
  }
  const limit = Math.min(100, Math.max(1, options.limit));
  const rows = await db
    .prepare(
      `SELECT event_json FROM requests WHERE endpoint IN ('messages', 'responses')
    AND started_at >= ? AND started_at < ? ${filter.sql} ${cursorSql}
    ORDER BY started_at DESC, request_id DESC LIMIT ?`,
    )
    .bind(range.from, range.to, ...filter.values, ...extra, limit + 1)
    .all<{ event_json: string }>();
  const events = rows.results.map((row) => parseUsageEvent(row.event_json));
  const more = events.length > limit;
  const items = events.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      more && last
        ? btoa(JSON.stringify([last.started_at, last.request_id]))
        : null,
    range,
  };
}

export async function requestDetail(
  db: D1Database,
  id: string,
): Promise<UsageEvent | null> {
  const row = await db
    .prepare("SELECT event_json FROM requests WHERE request_id = ?")
    .bind(id)
    .first<{ event_json: string }>();
  return row ? parseUsageEvent(row.event_json) : null;
}

export async function cleanupRequests(
  db: D1Database,
  retentionDays: number,
): Promise<void> {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (let pass = 0; pass < 5; pass++) {
    const result = await db
      .prepare(
        "DELETE FROM requests WHERE request_id IN (SELECT request_id FROM requests WHERE started_at < ? LIMIT 1000)",
      )
      .bind(cutoff)
      .run();
    if (result.meta.changes < 1000) break;
  }
}

export const PENDING_REQUEST_MAX_AGE_MS = 15 * 60_000;

/**
 * Closes requests whose isolate died before the meter could finish them, such
 * as CPU-limit terminations. The row is finalized in place so the hourly
 * rollup triggers count it as failed, and the stored event stays consistent.
 */
export async function expirePendingRequests(
  db: D1Database,
  maxAgeMs = PENDING_REQUEST_MAX_AGE_MS,
  now = Date.now(),
): Promise<number> {
  const cutoff = now - maxAgeMs;
  let expired = 0;
  for (let pass = 0; pass < 5; pass++) {
    const result = await db
      .prepare(
        `UPDATE requests SET
          event_sequence = 2,
          finished_at = ?1,
          outcome = 'failed',
          duration_ms = ?1 - started_at,
          event_json = json_set(event_json,
            '$.sequence', 2,
            '$.phase', 'finished',
            '$.finished_at', ?1,
            '$.outcome', 'failed',
            '$.diagnostic_code', 'worker_terminated',
            '$.observation_issue', 'stream_abandoned',
            '$.duration_ms', ?1 - started_at)
        WHERE request_id IN (
          SELECT request_id FROM requests
          WHERE finished_at IS NULL AND started_at < ?2 LIMIT 1000)`,
      )
      .bind(now, cutoff)
      .run();
    expired += result.meta.changes;
    if (result.meta.changes < 1000) break;
  }
  return expired;
}
