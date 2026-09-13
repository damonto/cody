import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import { Empty } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import type { Summary } from "@/lib/api";
import { compact, date, money, number } from "@/lib/format";
import { DAY_MS, HOUR_MS } from "../../../../src/reporting/ranges";
import {
  knownCost,
  metricValue,
  trendInterval,
  trendPoints,
  type MetricName,
  type TrendPoint,
} from "./data";

function TrendTooltip({
  active,
  point,
  metric,
  currency,
  timeZone,
}: {
  active?: boolean;
  point?: TrendPoint;
  metric: MetricName;
  currency: string;
  timeZone: string;
}) {
  if (!active || !point) return null;
  return (
    <div className="max-w-80 space-y-2 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-md">
      {(["current", "previous"] as const).map((key) => {
        const bucket =
          key === "current" ? point.currentBucket : point.previousBucket;
        if (!bucket) return null;
        const value = metricValue(bucket, metric, currency);
        return (
          <div key={key}>
            <p className="font-medium">
              {key === "current" ? "This period" : "Previous period"} ·{" "}
              {metric === "cost" ? money(value, currency) : number(value)}
            </p>
            <p className="mt-1 text-muted-foreground">
              {date(bucket.from, timeZone)} – {date(bucket.to, timeZone)}
            </p>
            <p className="mt-1 text-muted-foreground">
              {number(bucket.totals.requests_count)} completed requests
              {bucket.partial ? " · Partial interval" : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function UsageTrend({
  data,
  metric,
  setMetric,
  currency,
}: {
  data: Summary;
  metric: MetricName;
  setMetric: (metric: MetricName) => void;
  currency: string;
}) {
  const previous =
    data.previous &&
    data.previous.totals.requests_count > 0 &&
    (metric === "cost"
      ? knownCost(data.previous, currency)
      : metricValue(data.previous, metric, currency)) !== null
      ? data.previous
      : null;
  const points = useMemo(
    () => trendPoints(data, previous, metric, currency),
    [data, previous, metric, currency],
  );
  const interval = trendInterval(data);
  const units =
    interval < DAY_MS ? interval / HOUR_MS + "h" : interval / DAY_MS + "d";
  const title =
    metric === "requests"
      ? "Requests"
      : metric === "tokens"
        ? "Tokens"
        : "Known cost " + currency;
  const available =
    metric === "cost"
      ? knownCost(data, currency) !== null
      : metricValue(data, metric, currency) !== null;
  const ticks = new Intl.DateTimeFormat("en-US", {
    timeZone: data.range.time_zone,
    ...(data.range.to - data.range.from <= 2 * DAY_MS
      ? ({ hour: "2-digit", minute: "2-digit" } as const)
      : {
          month: "short",
          day: "numeric",
          ...(data.range.period === "total"
            ? { year: "2-digit" as const }
            : {}),
        }),
  });
  return (
    <Card className="min-w-0 gap-4 shadow-none">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle role="heading" aria-level={2}>
          Usage trend
        </CardTitle>
        <div className="flex gap-1" role="group" aria-label="Trend metric">
          {(["requests", "tokens", "cost"] as const).map((name) => (
            <Button
              key={name}
              size="sm"
              variant={metric === name ? "secondary" : "ghost"}
              aria-pressed={metric === name}
              onClick={() => setMetric(name)}
            >
              {name === "requests"
                ? "Requests"
                : name === "tokens"
                  ? "Tokens"
                  : "Cost"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {data.series.length && available ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              {title} / {units}
            </p>
            <ChartContainer
              config={{
                current: {
                  label: "This period",
                  color: "var(--overview-accent)",
                },
                previous: {
                  label: "Previous period",
                  color: "var(--muted-foreground)",
                },
              }}
              className="h-64 w-full"
              aria-label={title + " over time"}
            >
              <ComposedChart
                data={points}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                accessibilityLayer
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={36}
                  tickFormatter={(time: number) => ticks.format(time)}
                />
                <YAxis
                  width={58}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    metric === "cost"
                      ? value > 0 && value < 1e7
                        ? (value / 1e9).toExponential(1)
                        : compact(value / 1e9)
                      : compact(value)
                  }
                />
                <ChartTooltip
                  content={({ active, label }) => (
                    <TrendTooltip
                      active={active}
                      point={points.find((point) => point.time === label)}
                      metric={metric}
                      currency={currency}
                      timeZone={data.range.time_zone}
                    />
                  )}
                />
                <Area
                  data={points.filter((point) => point.currentBucket)}
                  dataKey="current"
                  type="linear"
                  stroke="var(--color-current)"
                  fill="var(--color-current)"
                  fillOpacity={0.07}
                  strokeWidth={2}
                  isAnimationActive={false}
                  connectNulls={false}
                  dot={false}
                />
                {previous && (
                  <Line
                    data={points.filter((point) => point.previousBucket)}
                    dataKey="previous"
                    type="linear"
                    stroke="var(--color-previous)"
                    strokeWidth={1.4}
                    strokeDasharray="4 4"
                    isAnimationActive={false}
                    connectNulls={false}
                    dot={false}
                  />
                )}
              </ComposedChart>
            </ChartContainer>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <div className="flex flex-wrap gap-4">
                <span className="flex items-center gap-1.5">
                  <span className="w-4 border-t-2 border-[var(--overview-accent)]" />
                  This period
                </span>
                {previous && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 border-t border-dashed border-muted-foreground" />
                    Previous · same elapsed time
                  </span>
                )}
              </div>
              <span>Time · {data.range.time_zone}</span>
            </div>
          </>
        ) : (
          <Empty
            title={
              data.series.length
                ? metric === "cost"
                  ? "No priced usage in this period"
                  : "Token usage was not reported"
                : "Your traffic will appear here"
            }
          >
            Reported usage will appear as inference requests complete.
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}
