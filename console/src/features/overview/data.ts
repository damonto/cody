import {
  summarize,
  type Aggregate,
  type Rollup,
  type SeriesRow,
} from "../../../../src/reporting/aggregates.ts";
import {
  DAY_MS,
  HOUR_MS,
  type ReportRange,
} from "../../../../src/reporting/ranges.ts";
import type {
  ReportQuery,
  ReportQueryParams,
} from "../../../../src/reporting/query.ts";

export type MetricName = ReportQuery["sort_by"];
export type RequestDrilldownFilters = Pick<
  ReportQueryParams,
  "outcome" | "quality" | "currency"
>;
export interface Bucket extends Rollup {
  from: number;
  to: number;
  partial: boolean;
}
export interface SeriesReport extends Rollup {
  range: ReportRange;
  bucket_ms: number;
  series: readonly SeriesRow[];
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function percentage(value: number | null): string {
  return value === null ? "—" : value.toFixed(2) + "%";
}

export function tokenTotal(totals: Aggregate): number | null {
  const total = totals.input_tokens + totals.output_tokens;
  return total === 0 && totals.missing_usage_count > 0 ? null : total;
}

export function cacheShare(totals: Aggregate): number | null {
  const knownInput =
    totals.uncached_input_tokens +
    totals.cache_read_tokens +
    totals.cache_write_tokens;
  if (knownInput > totals.input_tokens) return null;
  if (!totals.cache_read_tokens && knownInput < totals.input_tokens)
    return null;
  return ratio(totals.cache_read_tokens, totals.input_tokens);
}

export function knownCost(rollup: Rollup, currency: string): number | null {
  const amount = rollup.currencies[currency];
  if (!amount) return null;
  return amount.cost_nano === 0 &&
    amount.unpriced_count === amount.requests_count
    ? null
    : amount.cost_nano;
}

export function metricValue(
  rollup: Rollup,
  metric: MetricName,
  currency: string,
): number | null {
  if (metric === "requests") return rollup.totals.requests_count;
  if (metric === "tokens") return tokenTotal(rollup.totals);
  if (!currency) return null;
  if (!rollup.currencies[currency]) return 0;
  return knownCost(rollup, currency);
}

export function comparisonLabel(
  current: number | null,
  previous: number | null,
  points = false,
): string {
  if (current === null || previous === null || (!points && previous === 0))
    return "No comparable baseline";
  const difference = points
    ? current - previous
    : (current / previous - 1) * 100;
  return `${difference > 0 ? "+" : ""}${difference.toFixed(points ? 2 : 1)}${points ? " pp" : "%"} vs previous`;
}

export function trendInterval(report: SeriesReport): number {
  const start =
    report.range.period === "total"
      ? (report.series[0]?.hour ?? report.range.to)
      : report.range.from;
  const span = report.range.to - start;
  let interval: number;
  if (span <= 2 * DAY_MS) interval = HOUR_MS;
  else if (span <= 14 * DAY_MS) interval = 6 * HOUR_MS;
  else if (span <= 93 * DAY_MS) interval = DAY_MS;
  else if (span <= 2 * 366 * DAY_MS) interval = 7 * DAY_MS;
  else
    interval = 28 * DAY_MS * Math.max(1, Math.ceil(span / (180 * 28 * DAY_MS)));
  return Math.max(report.bucket_ms, interval);
}

/** Empty buckets mean no reported requests, not proof that collection was healthy. */
export function reportBuckets(
  report: SeriesReport,
  interval = report.bucket_ms,
): Bucket[] {
  if (!report.series.length) return [];
  const width = Math.max(interval, report.bucket_ms);
  const groups = new Map<number, SeriesRow[]>();
  for (const row of report.series) {
    const time = Math.floor(row.hour / width) * width;
    const group = groups.get(time) ?? [];
    group.push(row);
    groups.set(time, group);
  }
  const from =
    report.range.period === "total"
      ? Math.max(report.range.from, report.series[0].hour)
      : report.range.from;
  const result: Bucket[] = [];
  for (
    let time = Math.floor(from / width) * width;
    time < report.range.to;
    time += width
  ) {
    const start = Math.max(time, from);
    const end = Math.min(time + width, report.range.to);
    result.push({
      from: start,
      to: end,
      partial: start !== time || end !== time + width,
      ...summarize(groups.get(time) ?? []),
    });
  }
  return result;
}

export interface TrendPoint {
  time: number;
  current: number | null;
  previous: number | null;
  currentBucket?: Bucket;
  previousBucket?: Bucket;
}

export function trendPoints(
  current: SeriesReport,
  previous: SeriesReport | null,
  metric: MetricName,
  currency: string,
): TrendPoint[] {
  const interval = trendInterval(current);
  const points = new Map<number, TrendPoint>();
  const add = (report: SeriesReport, prior: boolean) => {
    for (const bucket of reportBuckets(report, interval)) {
      const time = prior
        ? current.range.from + bucket.from - report.range.from
        : bucket.from;
      const point = points.get(time) ?? { time, current: null, previous: null };
      if (prior) {
        point.previous = metricValue(bucket, metric, currency);
        point.previousBucket = bucket;
      } else {
        point.current = metricValue(bucket, metric, currency);
        point.currentBucket = bucket;
      }
      points.set(time, point);
    }
  };
  add(current, false);
  if (previous) add(previous, true);
  return [...points.values()].sort((a, b) => a.time - b.time);
}

export function requestsHref(
  filters: ReportQueryParams,
  range: ReportRange,
  overrides: RequestDrilldownFilters = {},
): string {
  const query = new URLSearchParams();
  for (const name of [
    "provider_id",
    "credential_id",
    "client_id",
    "model",
    "currency",
  ] as const) {
    if (filters[name]) query.set(name, filters[name]);
  }
  query.set("time_zone", range.time_zone);
  query.set("period", range.period === "total" ? "total" : "custom");
  if (range.period !== "total") {
    query.set("from", String(range.from));
    query.set("to", String(range.to));
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value) query.set(name, value);
    else query.delete(name);
  }
  return "/requests?" + query.toString();
}
