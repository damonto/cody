import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { app } from "../../src/worker.ts";
import { DAY_MS, HOUR_MS, reportRange } from "../../src/reporting/ranges.ts";
import {
  cleanupRequests,
  expirePendingRequests,
  ingestUsage,
  reportDimensions,
  requestDetail,
  requestList,
  summary,
} from "../../src/reporting/store.ts";
import { usage } from "./fixtures.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const now = Date.UTC(2026, 8, 12, 12, 30);
const window = (from: number, to: number) => ({
  from,
  to,
  time_zone: "UTC",
  period: "custom" as const,
});
const call = (query: string, path = "summary") =>
  app.request(
    "http://localhost/console/api/" + path + "?" + query,
    { headers: { "x-cody-admin": "1" } },
    bindings,
    createExecutionContext(),
  );

beforeAll(async () => {
  await applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  await bindings.CODY_DB.batch(
    ["request_attempts", "requests", "usage_hourly"].map((table) =>
      bindings.CODY_DB.prepare("DELETE FROM " + table),
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

test("invalid first response values cannot enter request or aggregate rows", async () => {
  for (const value of [
    "2200",
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    {},
  ]) {
    const event = usage("invalid-latency", now - HOUR_MS);
    // Simulate a malformed value arriving over the Queue's JSON boundary.
    Reflect.set(event, "first_response_ms", value);
    await expect(ingestUsage(bindings.CODY_DB, event)).rejects.toThrow(
      "Invalid first response latency",
    );
  }
  expect(await requestDetail(bindings.CODY_DB, "invalid-latency")).toBeNull();
  const result = await summary(
    bindings.CODY_DB,
    window(now - 2 * HOUR_MS, now),
    {},
  );
  expect(result.totals.requests_count).toBe(0);
  expect(result.totals.first_response_samples).toBe(0);
});

test("first response samples stay independent across hourly rollups and request edges", async () => {
  const base = Date.UTC(2026, 8, 12);
  const samples = [
    [40, 2200],
    [70, 0],
    [90, undefined],
    [130, null],
    [140, 1100],
  ] as const;
  for (const [minute, latency] of samples) {
    const event = usage("latency-" + minute, base + minute * 60_000);
    event.transport = latency === null ? "http" : "sse";
    event.duration_ms = 125145;
    event.finished_at = event.started_at + event.duration_ms;
    event.ttft_ms = latency === null ? null : 7679;
    event.first_text_ms = null;
    if (latency === undefined) delete event.first_response_ms;
    else event.first_response_ms = latency;
    const start: UsageEvent = {
      ...event,
      phase: "started",
      sequence: 0,
      finished_at: null,
      outcome: "pending",
      first_response_ms: null,
    };
    // Exercise both finish triggers and delayed/duplicate queue deliveries.
    if (minute === 40) await ingestUsage(bindings.CODY_DB, start);
    await ingestUsage(bindings.CODY_DB, event);
    await ingestUsage(bindings.CODY_DB, event);
    await ingestUsage(bindings.CODY_DB, start);
    await ingestUsage(bindings.CODY_DB, { ...start, sequence: 1 });
    expect(
      await requestDetail(bindings.CODY_DB, event.request_id),
    ).toMatchObject({
      first_response_ms: latency ?? null,
      first_text_ms: null,
    });
  }
  const pending: UsageEvent = {
    ...usage("latency-pending", base + 80 * 60_000),
    phase: "started",
    sequence: 1,
    outcome: "pending",
    finished_at: null,
    first_response_ms: 9000,
  };
  await ingestUsage(bindings.CODY_DB, pending);
  for (const range of [
    window(base, base + 3 * HOUR_MS),
    window(base + 30 * 60_000, base + 150 * 60_000),
  ]) {
    const result = await summary(bindings.CODY_DB, range, {});
    expect(result.totals).toMatchObject({
      requests_count: 5,
      first_response_sum: 3300,
      first_response_samples: 3,
      ttft_samples: 4,
      first_text_samples: 0,
    });
    expect(result.pending).toBe(1);
    expect(
      result.series.reduce((sum, row) => sum + row.first_response_sum, 0),
    ).toBe(3300);
    expect(result.ranking.items[0].totals.first_response_samples).toBe(3);
  }
  const zero = await summary(
    bindings.CODY_DB,
    window(base + 69 * 60_000, base + 71 * 60_000),
    {},
  );
  expect(zero.totals.first_response_sum).toBe(0);
  expect(zero.totals.first_response_samples).toBe(1);
  const list = await requestList(
    bindings.CODY_DB,
    window(base, base + 3 * HOUR_MS),
    {},
    { limit: 10 },
  );
  expect(
    list.items.find((item) => item.request_id === "latency-90")
      ?.first_response_ms,
  ).toBeNull();
});

test("overview totals, ranking and currency series share exact request boundaries", async () => {
  const base = Date.UTC(2026, 8, 12);
  for (const [index, minute] of [29, 30, 90, 139, 140].entries()) {
    const event = usage(
      "boundary-" + index,
      base + minute * 60_000,
      index === 2 ? "EUR" : "USD",
    );
    event.provider_id = index === 2 ? "retired-provider" : "provider";
    await ingestUsage(bindings.CODY_DB, event);
    await ingestUsage(bindings.CODY_DB, event);
  }
  const result = await summary(
    bindings.CODY_DB,
    window(base + 30 * 60_000, base + 140 * 60_000),
    {},
  );
  expect(result.totals.requests_count).toBe(3);
  expect(result.totals.input_tokens + result.totals.output_tokens).toBe(3300);
  expect(result.totals.cost_nano).toBe(0);
  expect(result.series.reduce((sum, row) => sum + row.requests_count, 0)).toBe(
    3,
  );
  expect(
    result.ranking.items.reduce(
      (sum, row) => sum + row.totals.requests_count,
      0,
    ),
  ).toBe(3);
  expect(
    result.ranking.items.find((row) => row.value === "provider")?.totals
      .requests_count,
  ).toBe(2);
  expect(Object.keys(result.currencies).sort()).toEqual(["EUR", "USD"]);
  expect(result.ranking.other).toBeNull();
  const list = await requestList(
    bindings.CODY_DB,
    result.range,
    {},
    { limit: 50 },
  );
  expect(list.items.map((item) => item.request_id)).toEqual([
    "boundary-3",
    "boundary-2",
    "boundary-1",
  ]);
  for (const [from, to] of [
    [30, 31],
    [59, 91],
    [60, 120],
  ]) {
    const partial = await summary(
      bindings.CODY_DB,
      window(base + from * 60_000, base + to * 60_000),
      {},
    );
    expect(partial.totals.requests_count).toBe(1);
  }
  const midnight = await summary(
    bindings.CODY_DB,
    reportRange("day", "UTC", base),
    {},
  );
  expect(midnight.totals.requests_count).toBe(0);
  expect(midnight.series).toEqual([]);
  expect(midnight.previous).toBeNull();
});

test("report queries read hourly aggregates without scanning interior request details", async () => {
  const base = Date.UTC(2026, 8, 12);
  await bindings.CODY_DB.prepare(
    `WITH RECURSIVE samples(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM samples WHERE n < 1000
     )
     INSERT INTO requests (
       request_id, event_sequence, started_at, finished_at, endpoint, protocol,
       transport, kind, outcome, usage_status, billing_status, event_json,
       provider_id, model, client_id
     )
     SELECT 'volume-' || n, 2, ?, ?, 'responses', 'openai', 'http', 'inference',
       'success', 'reported', 'complete', '{}', 'provider', 'real-model', 'client'
       FROM samples`,
  )
    .bind(base + HOUR_MS, base + HOUR_MS + 1000)
    .run();
  await ingestUsage(bindings.CODY_DB, {
    ...usage("pending-volume", base + HOUR_MS),
    phase: "started",
    sequence: 1,
    finished_at: null,
    outcome: "pending",
  });
  let rowsRead = 0;
  const executeBatch = bindings.CODY_DB.batch.bind(bindings.CODY_DB);
  vi.spyOn(bindings.CODY_DB, "batch").mockImplementation(
    async <T>(statements: D1PreparedStatement[]) => {
      const results = await executeBatch<T>(statements);
      rowsRead += results.reduce(
        (sum, result) => sum + result.meta.rows_read,
        0,
      );
      return results;
    },
  );
  for (const filters of [
    {},
    { provider_id: "provider" },
    { provider_id: "provider", model: "real-model" },
    { client_id: "client" },
  ] as const) {
    rowsRead = 0;
    const report = await summary(
      bindings.CODY_DB,
      window(base + HOUR_MS / 2, base + 2.5 * HOUR_MS),
      filters,
      { compare: false },
    );
    expect(report.totals.requests_count).toBe(1000);
    expect(report.pending).toBe(1);
    // Two empty partial hours and one rollup should cost far fewer reads than
    // the 1,000 completed requests inside the full hour.
    expect(rowsRead, JSON.stringify(filters)).toBeLessThan(100);
  }
});

test("ranking uses the selected currency, preserves Other, and supports all three dimensions", async () => {
  const at = now - HOUR_MS;
  for (let provider = 0; provider < 7; provider++) {
    for (let index = 0; index <= provider; index++) {
      const event = usage("source-" + provider + "-" + index, at);
      event.provider_id = "provider-" + provider;
      event.model = "model-" + (provider % 2);
      event.client_id = "client-" + (provider % 3);
      event.billing.total_nano = provider === 0 ? 10e9 : 1e9;
      await ingestUsage(bindings.CODY_DB, event);
    }
  }
  for (const [provider, cost] of [
    [0, 2e9],
    [6, 100e9],
  ]) {
    const event = usage("eur-" + provider, at, "EUR");
    event.provider_id = "provider-" + provider;
    event.model = "model-" + (provider % 2);
    event.client_id = "client-" + (provider % 3);
    event.billing.total_nano = cost;
    await ingestUsage(bindings.CODY_DB, event);
  }
  const range = reportRange("day", "UTC", now);
  const usd = await summary(
    bindings.CODY_DB,
    range,
    {},
    { sort_by: "cost", cost_currency: "USD" },
  );
  const eur = await summary(
    bindings.CODY_DB,
    range,
    {},
    { sort_by: "cost", cost_currency: "EUR" },
  );
  expect(usd.totals.requests_count).toBe(30);
  expect(eur.totals).toEqual(usd.totals);
  expect(usd.ranking.items[0].value).toBe("provider-0");
  expect(eur.ranking.items[0].value).toBe("provider-6");
  expect(usd.ranking.items).toHaveLength(5);
  expect(usd.ranking.other?.totals.requests_count).toBe(5);
  for (const report of [usd, eur]) {
    expect(
      report.ranking.items.reduce(
        (sum, row) => sum + row.totals.requests_count,
        report.ranking.other?.totals.requests_count ?? 0,
      ),
    ).toBe(30);
    for (const currency of ["USD", "EUR"]) {
      expect(
        report.ranking.items.reduce(
          (sum, row) => sum + (row.currencies[currency]?.cost_nano ?? 0),
          report.ranking.other?.currencies[currency]?.cost_nano ?? 0,
        ),
      ).toBe(report.currencies[currency].cost_nano);
    }
  }
  for (const [dimension, size] of [
    ["model", 2],
    ["client_id", 3],
  ] as const) {
    const grouped = await summary(
      bindings.CODY_DB,
      range,
      {},
      { group_by: dimension, sort_by: "tokens" },
    );
    expect(grouped.ranking.items).toHaveLength(size);
    expect(
      grouped.ranking.items.reduce(
        (sum, row) => sum + row.totals.requests_count,
        0,
      ),
    ).toBe(30);
  }
});

test("previous periods keep the same filters and exclude the unused part of the previous day", async () => {
  const current = reportRange("day", "UTC", now);
  const previousStart = current.from - DAY_MS;
  for (const [id, at, provider] of [
    ["current", current.from + HOUR_MS, "provider"],
    ["previous", previousStart + HOUR_MS, "provider"],
    ["previous-other", previousStart + HOUR_MS, "other"],
    ["previous-too-late", previousStart + 14 * HOUR_MS, "provider"],
  ] as const) {
    await ingestUsage(bindings.CODY_DB, {
      ...usage(id, at),
      provider_id: provider,
    });
  }
  const result = await summary(bindings.CODY_DB, current, {
    provider_id: "provider",
  });
  expect(result.totals.requests_count).toBe(1);
  expect(result.previous?.totals.requests_count).toBe(1);
  expect(result.previous!.range.to - result.previous!.range.from).toBe(
    current.to - current.from,
  );
});

test("historic sources and costs survive request retention", async () => {
  const at = Math.floor((now - 200 * DAY_MS) / HOUR_MS) * HOUR_MS;
  await ingestUsage(bindings.CODY_DB, {
    ...usage("old-source", at),
    provider_id: "deleted-provider",
    client_id: "retired-client",
  });
  await cleanupRequests(bindings.CODY_DB, 120);
  const range = reportRange("total", "UTC", now);
  const result = await summary(bindings.CODY_DB, range, {});
  expect(result.totals.requests_count).toBe(1);
  expect(result.ranking.items[0].value).toBe("deleted-provider");
  expect(result.previous).toBeNull();
  expect(result.bucket_ms).toBe(7 * DAY_MS);
  const dimensions = await reportDimensions(bindings.CODY_DB, range);
  expect(dimensions.providers).toContain("deleted-provider");
  expect(dimensions.clients).toContain("retired-client");
  expect(
    (await requestList(bindings.CODY_DB, range, {}, { limit: 10 })).items,
  ).toEqual([]);
});

test("abandoned pending requests are finalized as failed and rolled up", async () => {
  const stale = usage("stale", now - HOUR_MS);
  const fresh = usage("fresh", now - 60_000);
  for (const event of [stale, fresh]) {
    await ingestUsage(bindings.CODY_DB, {
      ...event,
      phase: "started",
      sequence: 1,
      finished_at: null,
      outcome: "pending",
      duration_ms: null,
    });
  }
  // Other tests may leave their own pending rows behind; this one must be among them.
  expect(
    await expirePendingRequests(bindings.CODY_DB, 15 * 60_000, now),
  ).toBeGreaterThanOrEqual(1);
  const detail = await requestDetail(bindings.CODY_DB, "stale");
  expect(detail?.phase).toBe("finished");
  expect(detail?.outcome).toBe("failed");
  expect(detail?.finished_at).toBe(now);
  // The reaper cannot know when the request really ended, so its duration
  // stays unknown instead of measuring the cron delay.
  expect(detail?.duration_ms).toBeNull();
  expect(detail?.diagnostic_code).toBe("worker_terminated");
  expect((await requestDetail(bindings.CODY_DB, "fresh"))?.outcome).toBe(
    "pending",
  );
  const range = reportRange("total", "UTC", now);
  const result = await summary(bindings.CODY_DB, range, {});
  expect(result.totals.failed_count).toBe(1);
  expect(result.totals.duration_samples).toBe(0);
  expect(result.totals.duration_sum).toBe(0);
  // A late terminal event for the expired request no longer replaces the row.
  await ingestUsage(bindings.CODY_DB, stale);
  expect((await requestDetail(bindings.CODY_DB, "stale"))?.outcome).toBe(
    "failed",
  );
  expect(await expirePendingRequests(bindings.CODY_DB, 15 * 60_000, now)).toBe(
    0,
  );
});

test("quality drilldowns include only completed requests matching the same dimensions", async () => {
  const at = now - HOUR_MS;
  const partial = usage("partial", at);
  partial.usage.status = "partial";
  partial.billing.status = "partial";
  await ingestUsage(bindings.CODY_DB, partial);
  await ingestUsage(bindings.CODY_DB, usage("reported", at));
  await ingestUsage(bindings.CODY_DB, {
    ...partial,
    request_id: "pending",
    phase: "started",
    sequence: 1,
    finished_at: null,
    outcome: "pending",
  });
  const range = reportRange("day", "UTC", now);
  for (const quality of ["missing_usage", "incomplete_pricing"] as const) {
    const result = await requestList(
      bindings.CODY_DB,
      range,
      { provider_id: "provider", client_id: "client" },
      { limit: 50, quality },
    );
    expect(result.items.map((item) => item.request_id)).toEqual(["partial"]);
  }
});

test("report APIs validate ranges and expose historical boundary limitations", async () => {
  for (const query of [
    "period=custom",
    "period=custom&from=10&to=1",
    "period=custom&from=1&to=" + (now + 1),
    "period=day&from=1&to=2",
    "group_by=invalid",
  ])
    expect((await call(query)).status).toBe(400);
  const from = now - 200 * DAY_MS + 1;
  const to = from + HOUR_MS;
  const result = await call("period=custom&from=" + from + "&to=" + to);
  expect(result.status).toBe(200);
  const data = (await result.json()) as {
    partial_history: boolean;
    previous: unknown;
  };
  expect(data.partial_history).toBe(true);
  expect(data.previous).toBeNull();
  await ingestUsage(bindings.CODY_DB, {
    ...usage("historic-option", now - HOUR_MS),
    provider_id: "historic-provider",
  });
  const options = await call("period=day", "report-options");
  expect(options.status).toBe(200);
  expect(await options.json()).toMatchObject({
    providers: ["historic-provider"],
    models: ["real-model"],
    clients: ["client"],
  });
});
