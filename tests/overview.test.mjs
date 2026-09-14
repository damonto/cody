import assert from "node:assert/strict";
import test from "node:test";
import { emptyAggregate, summarize } from "../src/reporting/aggregates.ts";
import { HOUR_MS } from "../src/reporting/ranges.ts";
import {
  cacheShare,
  comparisonLabel,
  knownCost,
  metricValue,
  ratio,
  reportBuckets,
  requestsHref,
  tokenTotal,
  trendPoints,
} from "../console/src/features/overview/data.ts";

const row = (hour, currency, values) => ({
  ...emptyAggregate(),
  hour,
  currency,
  ...values,
});
const report = (series, from = 0, to = 4 * HOUR_MS) => ({
  range: { from, to, time_zone: "UTC", period: "custom" },
  bucket_ms: HOUR_MS,
  series,
  ...summarize(series),
});

test("empty data, missing counters and a reported zero have different meanings", () => {
  const empty = emptyAggregate();
  assert.equal(tokenTotal(empty), 0);
  assert.equal(ratio(0, 0), null);
  assert.equal(
    tokenTotal({ ...empty, requests_count: 1, missing_usage_count: 1 }),
    null,
  );
  assert.equal(tokenTotal({ ...empty, requests_count: 1 }), 0);
  assert.equal(comparisonLabel(10, 0), "No comparable baseline");
  assert.equal(comparisonLabel(99, 98.5, true), "+0.50 pp vs previous");
});

test("cached input and reasoning never inflate total tokens", () => {
  const totals = {
    ...emptyAggregate(),
    requests_count: 2,
    input_tokens: 1000,
    output_tokens: 100,
    uncached_input_tokens: 200,
    cache_read_tokens: 700,
    cache_write_tokens: 100,
    reasoning_tokens: 40,
    reasoning_samples: 1,
  };
  assert.equal(tokenTotal(totals), 1100);
  assert.equal(cacheShare(totals), 70);
  assert.equal(
    cacheShare({ ...totals, cache_read_tokens: 0, uncached_input_tokens: 900 }),
    0,
  );
  assert.equal(
    cacheShare({ ...totals, cache_read_tokens: 0, uncached_input_tokens: 0 }),
    null,
  );
  assert.equal(cacheShare({ ...totals, cache_read_tokens: 2000 }), null);
});

test("currency selection changes costs while traffic totals stay the same", () => {
  const data = summarize([
    row(0, "USD", {
      requests_count: 2,
      input_tokens: 200,
      cost_nano: 5_000_000_000,
    }),
    row(0, "EUR", {
      requests_count: 3,
      input_tokens: 300,
      cost_nano: 7_000_000_000,
    }),
  ]);
  assert.equal(data.totals.requests_count, 5);
  assert.equal(data.totals.cost_nano, 0);
  assert.equal(knownCost(data, "USD"), 5_000_000_000);
  assert.equal(knownCost(data, "EUR"), 7_000_000_000);
  assert.equal(
    metricValue(data, "requests", "USD"),
    metricValue(data, "requests", "EUR"),
  );
  assert.equal(knownCost(data, "GBP"), null);
  const unknown = summarize([
    row(0, "USD", { requests_count: 1, unpriced_count: 1 }),
  ]);
  assert.equal(knownCost(unknown, "USD"), null);
  const free = summarize([row(0, "USD", { requests_count: 1 })]);
  assert.equal(knownCost(free, "USD"), 0);
});

test("time buckets fill report gaps, clip edges and preserve all reported counts", () => {
  const data = report(
    [
      row(0, "USD", { requests_count: 2 }),
      row(2 * HOUR_MS, "USD", { requests_count: 3 }),
      row(2 * HOUR_MS, "EUR", { requests_count: 5 }),
    ],
    HOUR_MS / 2,
    3.25 * HOUR_MS,
  );
  const buckets = reportBuckets(data);
  assert.equal(buckets.length, 4);
  assert.equal(buckets[0].from, HOUR_MS / 2);
  assert.equal(buckets.at(-1).to, 3.25 * HOUR_MS);
  assert.deepEqual(
    buckets.map((bucket) => bucket.totals.requests_count),
    [2, 0, 8, 0],
  );
  assert.deepEqual(
    buckets.map((bucket) => bucket.partial),
    [true, false, false, true],
  );
  const combined = reportBuckets(data, 6 * HOUR_MS);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].totals.requests_count, 10);
});

test("comparison series retain their original timestamps when windows have different hour offsets", () => {
  const current = report(
    [row(3 * HOUR_MS, "USD", { requests_count: 2 })],
    3.5 * HOUR_MS,
    5 * HOUR_MS,
  );
  const previous = report(
    [row(2 * HOUR_MS, "USD", { requests_count: 3 })],
    2 * HOUR_MS,
    3.5 * HOUR_MS,
  );
  const points = trendPoints(current, previous, "requests", "USD");
  const point = points.find(
    (entry) => entry.previousBucket?.from === previous.range.from,
  );
  assert.equal(point.time, current.range.from);
  assert.equal(point.previousBucket.from, previous.range.from);
  assert.equal(
    points.reduce((sum, entry) => sum + (entry.current ?? 0), 0),
    2,
  );
  assert.equal(
    points.reduce((sum, entry) => sum + (entry.previous ?? 0), 0),
    3,
  );
});

test("request drilldowns freeze exact bounds and carry only relevant filters", () => {
  const range = {
    from: 123,
    to: 456,
    period: "week",
    time_zone: "Asia/Kathmandu",
  };
  const href = requestsHref(
    {
      provider_id: "a & b",
      model: "real/model",
      client_id: "stable-client",
      credential_id: "key",
      group_by: "client_id",
      cost_currency: "EUR",
    },
    range,
    { outcome: "failed", currency: "EUR" },
  );
  const query = new URL(href, "https://example.test").searchParams;
  assert.equal(query.get("period"), "custom");
  assert.equal(query.get("from"), "123");
  assert.equal(query.get("to"), "456");
  assert.equal(query.get("provider_id"), "a & b");
  assert.equal(query.get("model"), "real/model");
  assert.equal(query.get("client_id"), "stable-client");
  assert.equal(query.has("kind"), false);
  assert.equal(query.get("currency"), "EUR");
  assert.equal(query.has("cost_currency"), false);
  assert.equal(query.has("group_by"), false);
  const total = new URL(
    requestsHref({}, { ...range, from: 0, period: "total" }),
    "https://example.test",
  ).searchParams;
  assert.equal(total.get("period"), "total");
  assert.equal(total.has("from"), false);
});
