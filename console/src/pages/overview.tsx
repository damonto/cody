import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Coins,
  Layers,
  Timer,
  TrendingUp,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { read, rpc } from "@/lib/api";
import { compact, date, duration, money, number } from "@/lib/format";
import {
  Empty,
  ErrorNotice,
  Loading,
  Metric,
  PageHeading,
} from "@/components/common";
import { ReportFilters, useReportFilters } from "@/components/report-filters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";

export default function Overview() {
  const { values } = useReportFilters();
  const report = useQuery({
    queryKey: ["summary", values],
    queryFn: ({ signal }) =>
      read(rpc.summary.$get({ query: values }, { init: { signal } })),
    refetchInterval: 30_000,
  });
  const points = useMemo(() => {
    const grouped = new Map<
      number,
      { time: number; input: number; output: number; requests: number }
    >();
    for (const row of report.data?.series ?? []) {
      const time = row.hour;
      const point = grouped.get(time) ?? {
        time,
        input: 0,
        output: 0,
        requests: 0,
      };
      point.input += row.input_tokens;
      point.output += row.output_tokens;
      point.requests += row.requests_count;
      grouped.set(time, point);
    }
    return [...grouped.values()].sort((a, b) => a.time - b.time);
  }, [report.data]);
  const data = report.data;
  const totals = data?.totals;
  return (
    <>
      <PageHeading
        title="Usage overview"
        description="Understand traffic, token consumption, and spend across your gateway."
      >
        <Button variant="outline" asChild>
          <Link to="/requests">
            View requests
            <ArrowRight />
          </Link>
        </Button>
      </PageHeading>
      <ReportFilters
        timeZone={data?.range.time_zone}
        refresh={() => void report.refetch()}
        fetching={report.isFetching}
      />
      {report.error && (
        <ErrorNotice error={report.error} retry={() => void report.refetch()} />
      )}
      {report.isPending ? (
        <Loading />
      ) : (
        data &&
        totals && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                title="Requests"
                value={number(totals.requests_count)}
                hint={`${number(data.pending)} pending · inference requests`}
                icon={<Activity />}
              />
              <Metric
                title="Reported tokens"
                value={compact(totals.input_tokens + totals.output_tokens)}
                hint={`${compact(totals.input_tokens)} input · ${compact(totals.output_tokens)} output`}
                icon={<Layers />}
              />
              <Metric
                title="Known cost"
                value={
                  Object.entries(data.currencies).filter(
                    ([currency]) => currency,
                  ).length
                    ? Object.entries(data.currencies)
                        .filter(([currency]) => currency)
                        .map(([currency, amount]) => (
                          <div key={currency} className="text-2xl">
                            {money(amount.cost_nano, currency)}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {currency}
                            </span>
                          </div>
                        ))
                    : "—"
                }
                hint={`${number(totals.unpriced_count)} requests with incomplete pricing`}
                icon={<Coins />}
              />
              <Metric
                title="First text"
                value={duration(
                  totals.first_text_samples
                    ? totals.first_text_sum / totals.first_text_samples
                    : null,
                )}
                hint={`Average · ${number(totals.first_text_samples)} reported samples`}
                icon={<Timer />}
              />
            </div>
            {(totals.missing_usage_count > 0 || totals.unpriced_count > 0) && (
              <Alert>
                <TrendingUp />
                <AlertTitle>Some usage or cost is incomplete</AlertTitle>
                <AlertDescription>
                  {number(totals.missing_usage_count)} requests have missing or
                  partial token usage. Known cost includes only measurable
                  charges; it is not an invoice total. Reasoning is included in
                  output tokens.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle>Token traffic</CardTitle>
                  <CardDescription>
                    Input includes cache reads and writes. Output includes
                    reasoning.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {points.length ? (
                    <ChartContainer
                      config={{
                        input: { label: "Input", color: "var(--chart-1)" },
                        output: { label: "Output", color: "var(--chart-2)" },
                      }}
                      className="h-[300px] w-full"
                    >
                      <AreaChart
                        data={points}
                        margin={{ left: 0, right: 12, top: 12 }}
                        accessibilityLayer
                      >
                        <defs>
                          <linearGradient
                            id="input-fill"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="var(--color-input)"
                              stopOpacity={0.25}
                            />
                            <stop
                              offset="95%"
                              stopColor="var(--color-input)"
                              stopOpacity={0.02}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} />
                        <XAxis
                          dataKey="time"
                          tickLine={false}
                          axisLine={false}
                          minTickGap={40}
                          tickFormatter={(time: number) =>
                            new Intl.DateTimeFormat("en-US", {
                              timeZone: data.range.time_zone,
                              year:
                                values.period === "total"
                                  ? "numeric"
                                  : undefined,
                              ...(values.period === "day"
                                ? { hour: "2-digit", minute: "2-digit" }
                                : { month: "short", day: "numeric" }),
                            }).format(time)
                          }
                        />
                        <YAxis
                          tickFormatter={(value: number) => compact(value)}
                          axisLine={false}
                          tickLine={false}
                          width={48}
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              labelFormatter={(_value, payload) =>
                                date(
                                  payload[0]?.payload.time as number,
                                  data.range.time_zone,
                                )
                              }
                            />
                          }
                        />
                        <Area
                          dataKey="input"
                          type="monotone"
                          stroke="var(--color-input)"
                          fill="url(#input-fill)"
                          strokeWidth={2}
                        />
                        <Area
                          dataKey="output"
                          type="monotone"
                          stroke="var(--color-output)"
                          fill="var(--color-output)"
                          fillOpacity={0.05}
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ChartContainer>
                  ) : (
                    <Empty title="Your traffic will appear here">
                      Publish your configuration and send a request through the
                      gateway to start collecting usage.
                    </Empty>
                  )}
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle>Token breakdown</CardTitle>
                  <CardDescription>
                    Reported counters for this period
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {[
                    [
                      "Uncached input",
                      totals.uncached_input_tokens,
                      "bg-chart-1",
                    ],
                    ["Cache read", totals.cache_read_tokens, "bg-chart-3"],
                    ["Cache write", totals.cache_write_tokens, "bg-chart-4"],
                    ["Output", totals.output_tokens, "bg-chart-2"],
                  ].map(([title, count, color]) => (
                    <div key={title as string}>
                      <div className="mb-2 flex justify-between text-sm">
                        <span className="flex items-center gap-2">
                          <span className={`size-2 rounded-full ${color}`} />
                          {title}
                        </span>
                        <span className="font-medium tabular-nums">
                          {number(count as number)}
                        </span>
                      </div>
                      <Progress
                        value={
                          totals.input_tokens + totals.output_tokens
                            ? ((count as number) /
                                (totals.input_tokens + totals.output_tokens)) *
                              100
                            : 0
                        }
                        className="h-1.5"
                      />
                    </div>
                  ))}
                  <div className="flex justify-between border-t pt-4 text-sm">
                    <span className="text-muted-foreground">
                      Of output: reasoning
                    </span>
                    <span className="font-medium">
                      {totals.reasoning_samples
                        ? number(totals.reasoning_tokens)
                        : "Not reported"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="shadow-none">
                <CardHeader>
                  <CardDescription>Success rate</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">
                    {totals.requests_count
                      ? `${((totals.success_count / totals.requests_count) * 100).toFixed(1)}%`
                      : "—"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {number(totals.failed_count)} failed ·{" "}
                  {number(totals.cancelled_count)} cancelled ·{" "}
                  {number(totals.incomplete_count)} incomplete
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardHeader>
                  <CardDescription>Average duration</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">
                    {duration(
                      totals.duration_samples
                        ? totals.duration_sum / totals.duration_samples
                        : null,
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Request start to stream completion, including retries
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardHeader>
                  <CardDescription>First generation event</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">
                    {duration(
                      totals.ttft_samples
                        ? totals.ttft_sum / totals.ttft_samples
                        : null,
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Includes reasoning and tool argument deltas
                </CardContent>
              </Card>
            </div>
            <p className="text-xs text-muted-foreground">
              {data.range.period === "total"
                ? "All time through "
                : `${date(data.range.from, data.range.time_zone)} – `}
              {date(data.range.to, data.range.time_zone)} · Updated{" "}
              {date(data.updated_at, data.range.time_zone)}
            </p>
          </>
        )
      )}
    </>
  );
}
