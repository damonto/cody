import { Temporal } from "@js-temporal/polyfill";

export const REPORT_PERIODS = [
  "day",
  "week",
  "month",
  "7d",
  "30d",
  "total",
  "custom",
] as const;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const MAX_CUSTOM_RANGE_MS = 366 * DAY_MS;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export interface ReportRange {
  from: number;
  to: number;
  time_zone: string;
  period: ReportPeriod;
}

function periodStart(
  period: ReportPeriod,
  end: Temporal.ZonedDateTime,
): number {
  switch (period) {
    case "day":
      return end.startOfDay().epochMilliseconds;
    case "week":
      return end.subtract({ days: end.dayOfWeek - 1 }).startOfDay()
        .epochMilliseconds;
    case "month":
      return end.with({ day: 1 }).startOfDay().epochMilliseconds;
    case "total":
      return 0;
    case "7d":
      return Math.max(0, end.epochMilliseconds - 7 * DAY_MS);
    case "30d":
      return Math.max(0, end.epochMilliseconds - 30 * DAY_MS);
    case "custom":
      throw new Error("Custom reports require a start and end time");
  }
}

export function reportRange(
  period: ReportPeriod,
  timeZone: string,
  now = Date.now(),
  custom?: { from: number; to: number },
): ReportRange {
  const end =
    Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
  if (period === "custom") {
    if (
      !custom ||
      !Number.isSafeInteger(custom.from) ||
      !Number.isSafeInteger(custom.to) ||
      custom.from < 0 ||
      custom.to <= custom.from ||
      custom.to > now ||
      custom.to - custom.from > MAX_CUSTOM_RANGE_MS
    ) {
      throw new Error(
        "Choose a past time range of up to 366 days, with the end after the start",
      );
    }
    return { ...custom, time_zone: timeZone, period };
  }
  return {
    from: periodStart(period, end),
    to: now,
    time_zone: timeZone,
    period,
  };
}

/** Calendar periods compare the same elapsed duration from the prior start. */
export function previousRange(range: ReportRange): ReportRange | null {
  if (range.period === "total") return null;
  const elapsed = range.to - range.from;
  let from = range.from - elapsed;
  if (["day", "week", "month"].includes(range.period)) {
    const start = Temporal.Instant.fromEpochMilliseconds(
      range.from,
    ).toZonedDateTimeISO(range.time_zone);
    from = start.subtract(
      range.period === "day"
        ? { days: 1 }
        : range.period === "week"
          ? { weeks: 1 }
          : { months: 1 },
    ).epochMilliseconds;
  }
  // A shorter previous month or DST day cannot supply an equal window.
  if (from < 0 || elapsed <= 0 || from + elapsed > range.from) return null;
  return { ...range, from, to: from + elapsed };
}

export function reportBucketMs(range: ReportRange): number {
  const span = range.to - range.from;
  if (range.period === "total" || span > 366 * DAY_MS) return 7 * DAY_MS;
  return span > 31 * DAY_MS ? DAY_MS : HOUR_MS;
}
