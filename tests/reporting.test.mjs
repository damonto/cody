import assert from "node:assert/strict";
import test from "node:test";
import {
  DAY_MS,
  HOUR_MS,
  previousRange,
  reportBucketMs,
  reportRange,
} from "../src/reporting/ranges.ts";
import { reportQuerySchema } from "../src/admin/schema.ts";

test("day, Monday week and month use the chosen reporting time zone", () => {
  const now = Date.parse("2026-09-12T04:30:00Z");
  assert.equal(
    reportRange("day", "Asia/Shanghai", now).from,
    Date.parse("2026-09-11T16:00:00Z"),
  );
  assert.equal(
    reportRange("week", "Asia/Shanghai", now).from,
    Date.parse("2026-09-06T16:00:00Z"),
  );
  assert.equal(
    reportRange("month", "Asia/Shanghai", now).from,
    Date.parse("2026-08-31T16:00:00Z"),
  );
});

test("total includes all history through now in every reporting time zone", () => {
  const now = Date.parse("2026-09-12T04:30:00Z");
  for (const timeZone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    assert.deepEqual(reportRange("total", timeZone, now), {
      from: 0,
      to: now,
      time_zone: timeZone,
      period: "total",
    });
  }
});

test("day boundaries survive daylight-saving transitions", () => {
  const range = reportRange(
    "day",
    "America/New_York",
    Date.parse("2026-03-08T20:00:00Z"),
  );
  assert.equal(range.from, Date.parse("2026-03-08T05:00:00Z"));
});

test("rolling windows use elapsed days and custom windows preserve exact bounds", () => {
  const now = Date.parse("2026-09-12T04:30:12.345Z");
  for (const [period, days] of [
    ["7d", 7],
    ["30d", 30],
  ]) {
    const current = reportRange(period, "America/New_York", now);
    assert.equal(current.to - current.from, days * DAY_MS);
    const previous = previousRange(current);
    assert.equal(previous.to, current.from);
    assert.equal(previous.to - previous.from, current.to - current.from);
  }
  const bounds = { from: now - 91_337, to: now - 1 };
  const custom = reportRange("custom", "Asia/Kathmandu", now, bounds);
  assert.equal(custom.from, bounds.from);
  assert.equal(custom.to, bounds.to);
  assert.equal(previousRange(custom).to, bounds.from);
});

test("calendar comparisons use equal elapsed windows and never overlap", () => {
  const now = Date.parse("2026-09-12T04:30:00Z");
  for (const period of ["day", "week", "month"]) {
    const current = reportRange(period, "Asia/Shanghai", now);
    const previous = previousRange(current);
    assert.equal(previous.to - previous.from, current.to - current.from);
    assert.ok(previous.to <= current.from);
  }
  const dst = reportRange(
    "day",
    "America/New_York",
    Date.parse("2026-03-08T20:00:00Z"),
  );
  assert.equal(previousRange(dst).to - previousRange(dst).from, 15 * HOUR_MS);
  assert.equal(
    previousRange(
      reportRange("month", "UTC", Date.parse("2026-03-31T12:00:00Z")),
    ),
    null,
  );
  assert.equal(previousRange(reportRange("total", "UTC", now)), null);
});

test("report queries reject incomplete, reversed, excessive and invalid ranges", () => {
  for (const query of [
    { period: "custom" },
    { period: "custom", from: "10" },
    { period: "custom", from: "20", to: "10" },
    { period: "custom", from: "0", to: String(367 * DAY_MS) },
    { period: "custom", from: "NaN", to: "100" },
    { period: "custom", from: "-1", to: "100" },
    { period: "day", from: "1", to: "100" },
    { group_by: "service_id; DROP TABLE requests" },
    { sort_by: "anything" },
  ])
    assert.equal(reportQuerySchema.safeParse(query).success, false);
  assert.equal(
    reportQuerySchema.parse({ period: "custom", from: "1", to: "100" }).from,
    1,
  );
  assert.throws(() => reportRange("custom", "UTC", 100, { from: 1, to: 101 }));
});

test("long histories use coarser buckets while short reports retain hourly detail", () => {
  const now = Date.parse("2026-09-12T04:30:00Z");
  assert.equal(reportBucketMs(reportRange("7d", "UTC", now)), HOUR_MS);
  assert.equal(reportBucketMs(reportRange("30d", "UTC", now)), HOUR_MS);
  assert.equal(
    reportBucketMs(
      reportRange("custom", "UTC", now, { from: now - 120 * DAY_MS, to: now }),
    ),
    DAY_MS,
  );
  assert.equal(reportBucketMs(reportRange("total", "UTC", now)), 7 * DAY_MS);
});
