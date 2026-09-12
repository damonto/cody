import { Temporal } from "@js-temporal/polyfill";

export const REPORT_PERIODS = ["day", "week", "month", "total"] as const;
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
  }
}

export function reportRange(
  period: ReportPeriod,
  timeZone: string,
  now = Date.now(),
): ReportRange {
  const end =
    Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
  return {
    from: periodStart(period, end),
    to: now,
    time_zone: timeZone,
    period,
  };
}
