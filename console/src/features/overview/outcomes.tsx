import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Empty } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { Summary } from "@/lib/api";
import { number } from "@/lib/format";
import { DAY_MS, HOUR_MS } from "../../../../src/reporting/ranges";
import type { ReportQueryParams } from "../../../../src/reporting/query";
import {
  percentage,
  ratio,
  reportBuckets,
  requestsHref,
  type Bucket,
} from "./data";

function color(bucket: Bucket): string {
  const success = ratio(
    bucket.totals.success_count,
    bucket.totals.requests_count,
  );
  if (success === null) return "var(--muted)";
  if (success >= 99) return "var(--overview-accent)";
  if (success >= 95) return "var(--overview-write)";
  return "var(--overview-failure)";
}

export function OutcomeTimeline({
  data,
  filters,
}: {
  data: Summary;
  filters: ReportQueryParams;
}) {
  const compact = useMediaQuery("(max-width: 640px), (pointer: coarse)");
  const interval = Math.max(data.bucket_ms, compact ? 6 * HOUR_MS : HOUR_MS);
  const buckets = useMemo(
    () => reportBuckets(data, interval),
    [data, interval],
  );
  const [selected, setSelected] = useState<number | null>(null);
  const dateTime = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: data.range.time_zone,
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [data.range.time_zone],
  );
  const chosen =
    buckets.find(
      (bucket) =>
        selected !== null && selected >= bucket.from && selected < bucket.to,
    ) ??
    buckets.reduce<Bucket | undefined>(
      (best, bucket) =>
        !best || bucket.totals.failed_count > best.totals.failed_count
          ? bucket
          : best,
      undefined,
    );
  const dayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: data.range.time_zone,
    month: "short",
    day: "numeric",
  });
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: data.range.time_zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const rows = new Map<string, Bucket[]>();
  for (const bucket of buckets) {
    const key = dayKey.format(bucket.from);
    const row = rows.get(key) ?? [];
    row.push(bucket);
    rows.set(key, row);
  }
  const columns = Math.max(1, ...[...rows.values()].map((row) => row.length));
  const cell = (bucket: Bucket, labeled: boolean) => {
    const counts = bucket.totals;
    const label =
      dateTime.format(bucket.from) +
      " – " +
      dateTime.format(bucket.to) +
      ": " +
      number(counts.requests_count) +
      " reported requests, " +
      number(counts.success_count) +
      " success, " +
      number(counts.failed_count) +
      " failed, " +
      number(counts.cancelled_count) +
      " cancelled, " +
      number(counts.incomplete_count) +
      " incomplete" +
      (bucket.partial ? ". Partial interval." : "");
    return (
      <button
        key={bucket.from}
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={chosen?.from === bucket.from}
        className={
          "min-w-0 cursor-pointer rounded-sm outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-foreground " +
          (compact ? "min-h-11" : labeled ? "min-h-8" : "h-4")
        }
        style={{ background: color(bucket) }}
        onClick={() => setSelected(bucket.from)}
      >
        {labeled && (
          <span className="rounded-sm bg-background/90 px-1 text-[11px] text-foreground">
            {dayLabel.format(bucket.from)}
          </span>
        )}
      </button>
    );
  };
  const unit =
    interval < DAY_MS ? interval / HOUR_MS + "h" : interval / DAY_MS + "d";
  const detailRange = chosen
    ? {
        ...data.range,
        period: "custom" as const,
        from: chosen.from,
        to: chosen.to,
      }
    : null;
  const retained = chosen && chosen.to > data.retention.from;
  return (
    <Card className="min-w-0 gap-4 shadow-none">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle role="heading" aria-level={2}>
          Request outcomes
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          {unit} intervals · {data.range.time_zone}
        </span>
      </CardHeader>
      <CardContent>
        {buckets.length ? (
          <>
            {interval >= DAY_MS ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-7">
                {buckets.map((bucket) => cell(bucket, true))}
              </div>
            ) : (
              <div className="space-y-1">
                {[...rows].map(([key, row]) => (
                  <div
                    key={key}
                    className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-2"
                  >
                    <span className="text-[11px] text-muted-foreground">
                      {dayLabel.format(row[0].from)}
                    </span>
                    <div
                      className="grid gap-1"
                      style={{
                        gridTemplateColumns:
                          "repeat(" + columns + ", minmax(0, 1fr))",
                      }}
                    >
                      {row.map((bucket) => cell(bucket, false))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
              {[
                ["≥99% success", "var(--overview-accent)"],
                ["95–99%", "var(--overview-write)"],
                ["<95%", "var(--overview-failure)"],
                ["No reports", "var(--muted)"],
              ].map(([label, fill]) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-sm"
                    style={{ background: fill }}
                  />
                  {label}
                </span>
              ))}
            </div>
            {chosen && detailRange && (
              <div className="mt-4 space-y-3 border-t pt-3">
                <div aria-live="polite">
                  <p className="text-xs font-medium">
                    {dateTime.format(chosen.from)} –{" "}
                    {dateTime.format(chosen.to)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {number(chosen.totals.requests_count)} reported requests ·{" "}
                    {percentage(
                      ratio(
                        chosen.totals.success_count,
                        chosen.totals.requests_count,
                      ),
                    )}{" "}
                    success
                    {chosen.partial ? " · Partial interval" : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                  {(
                    [
                      ["success", chosen.totals.success_count],
                      ["failed", chosen.totals.failed_count],
                      ["cancelled", chosen.totals.cancelled_count],
                      ["incomplete", chosen.totals.incomplete_count],
                    ] as const
                  ).map(([outcome, count]) =>
                    retained ? (
                      <Link
                        key={outcome}
                        className="underline-offset-4 hover:underline"
                        to={requestsHref(filters, detailRange, { outcome })}
                      >
                        {number(count)} {outcome}
                      </Link>
                    ) : (
                      <span key={outcome}>
                        {number(count)} {outcome}
                      </span>
                    ),
                  )}
                </div>
                {retained ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link to={requestsHref(filters, detailRange)}>
                      View this interval
                      <ArrowRight />
                    </Link>
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Request details are outside the {data.retention.days}-day
                    retention window.
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <Empty title="No reported outcomes in this period" />
        )}
      </CardContent>
    </Card>
  );
}
