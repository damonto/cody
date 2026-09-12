import type { ReportRange } from "./ranges.ts";
import type { UsageEvent } from "../telemetry/types.ts";
import { USAGE_FIELDS } from "../billing/types.ts";

export const AGGREGATE_FIELDS = [
  "requests_count",
  "success_count",
  "failed_count",
  "cancelled_count",
  "incomplete_count",
  "missing_usage_count",
  "unpriced_count",
  "input_tokens",
  "uncached_input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "reasoning_tokens",
  "reasoning_samples",
  "cost_nano",
  "duration_sum",
  "duration_samples",
  "ttft_sum",
  "ttft_samples",
  "first_text_sum",
  "first_text_samples",
] as const;
export type AggregateField = (typeof AGGREGATE_FIELDS)[number];
export type Aggregate = Record<AggregateField, number>;
export type SeriesRow = Aggregate & { hour: number; currency: string };
export interface ReportFilters {
  service_id?: string;
  key_id?: string;
  client_id?: string;
  model?: string;
  kind?: string;
  currency?: string;
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
  ttft_sum: "COALESCE(NEW.ttft_ms, 0)",
  ttft_samples: "CASE WHEN NEW.ttft_ms IS NULL THEN 0 ELSE 1 END",
  first_text_sum: "COALESCE(NEW.first_text_ms, 0)",
  first_text_samples: "CASE WHEN NEW.first_text_ms IS NULL THEN 0 ELSE 1 END",
} as const;
const FILTER_FIELDS = [
  "service_id",
  "key_id",
  "client_id",
  "model",
  "kind",
  "currency",
] as const;

function conditions(filters: ReportFilters): { sql: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  for (const field of FILTER_FIELDS) {
    const value = filters[field];
    if (value) {
      clauses.push(`${field} = ?`);
      values.push(value);
    }
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", values };
}

export async function ingestUsage(
  db: D1Database,
  event: UsageEvent,
): Promise<void> {
  if (
    event.schema_version !== 1 ||
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
  const columns = [
    "request_id",
    "event_sequence",
    "started_at",
    "finished_at",
    "client_id",
    "service_id",
    "key_id",
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
    event.service_id,
    event.key_id,
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
    event.ttft_ms,
    event.first_text_ms,
    event.context_tokens,
    event.context_window,
    ...USAGE_FIELDS.map((field) => event.usage.tokens[field]),
    event.usage.status,
    event.billing.status,
    event.billing.total_nano,
    JSON.stringify(event),
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

export async function summary(
  db: D1Database,
  range: ReportRange,
  filters: ReportFilters,
) {
  const hour = 3_600_000;
  const fullStart = Math.ceil(range.from / hour) * hour;
  const fullEnd = Math.max(fullStart, Math.floor(range.to / hour) * hour);
  const filter = conditions(filters);
  const columns = AGGREGATE_FIELDS.join(", ");
  const edgeExpressions = AGGREGATE_FIELDS.map(
    (field) =>
      `${AGGREGATE_EXPRESSIONS[field].replaceAll("NEW.", "")} AS ${field}`,
  ).join(", ");
  const sql = `SELECT hour, currency, ${AGGREGATE_FIELDS.map((field) => `SUM(${field}) AS ${field}`).join(", ")}
    FROM (
      SELECT hour, currency, ${columns} FROM usage_hourly
        WHERE hour >= ? AND hour < ? ${filter.sql}
      UNION ALL
      SELECT (started_at / 3600000) * 3600000 AS hour, currency, ${edgeExpressions} FROM requests
        WHERE finished_at IS NOT NULL AND started_at >= ? AND started_at < ?
        AND NOT (started_at >= ? AND started_at < ?) ${filter.sql}
    ) GROUP BY hour, currency ORDER BY hour, currency`;
  const result = await db
    .prepare(sql)
    .bind(
      fullStart,
      fullEnd,
      ...filter.values,
      range.from,
      range.to,
      fullStart,
      fullEnd,
      ...filter.values,
    )
    .all<SeriesRow>();
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM requests WHERE finished_at IS NULL AND started_at >= ? AND started_at < ? ${filter.sql}`,
    )
    .bind(range.from, range.to, ...filter.values)
    .first<{ count: number }>();
  const totals = Object.fromEntries(
    AGGREGATE_FIELDS.map((field) => [field, 0]),
  ) as Aggregate;
  const currencies: Record<
    string,
    { cost_nano: number; unpriced_count: number }
  > = {};
  for (const row of result.results) {
    for (const field of AGGREGATE_FIELDS) {
      // Monetary amounts of different currencies are never added together.
      if (field !== "cost_nano") totals[field] += row[field];
    }
    const currency = (currencies[row.currency] ??= {
      cost_nano: 0,
      unpriced_count: 0,
    });
    currency.cost_nano += row.cost_nano;
    currency.unpriced_count += row.unpriced_count;
  }
  return {
    range,
    totals,
    currencies,
    pending: pending?.count ?? 0,
    series: result.results,
    updated_at: Date.now(),
  };
}

export async function requestList(
  db: D1Database,
  range: ReportRange,
  filters: ReportFilters,
  options: { limit: number; cursor?: string; outcome?: string },
) {
  const filter = conditions(filters);
  let cursorSql = "";
  const extra: (string | number)[] = [];
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
      !Number.isSafeInteger(cursor[0]) ||
      typeof cursor[1] !== "string"
    )
      throw new Error("Invalid cursor");
    cursorSql += " AND (started_at < ? OR (started_at = ? AND request_id < ?))";
    extra.push(cursor[0] as number, cursor[0] as number, cursor[1]);
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
  const events = rows.results.map(
    (row) => JSON.parse(row.event_json) as UsageEvent,
  );
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
  return row ? (JSON.parse(row.event_json) as UsageEvent) : null;
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
