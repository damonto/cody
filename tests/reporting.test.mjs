import assert from "node:assert/strict";
import test from "node:test";
import { reportRange } from "../src/reporting/ranges.ts";

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
