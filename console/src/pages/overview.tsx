import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  Coins,
  Info,
  Layers,
} from "lucide-react";
import { read, rpc } from "@/lib/api";
import { compact, date, money, number } from "@/lib/format";
import { Choice, ErrorNotice, Loading, PageHeading } from "@/components/common";
import { ReportFilters, useReportFilters } from "@/components/report-filters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Coverage, Efficiency, MetricCard } from "@/features/overview/metrics";
import { TokenComposition } from "@/features/overview/composition";
import { OutcomeTimeline } from "@/features/overview/outcomes";
import { SourceRanking } from "@/features/overview/ranking";
import { UsageTrend } from "@/features/overview/trend";
import {
  comparisonLabel,
  knownCost,
  metricValue,
  percentage,
  ratio,
  reportBuckets,
  requestsHref,
  tokenTotal,
  trendInterval,
  type MetricName,
  type RequestDrilldownFilters,
} from "@/features/overview/data";
import { DAY_MS } from "../../../src/reporting/ranges";

const logLink = "underline-offset-4 hover:text-foreground hover:underline";

export default function Overview() {
  const { values, change, invalid } = useReportFilters();
  const [metric, setMetric] = useState<MetricName>("requests");
  const query = {
    ...values,
    currency: undefined,
    outcome: undefined,
    quality: undefined,
    cursor: undefined,
  };
  const report = useQuery({
    queryKey: ["summary", query],
    queryFn: ({ signal }) =>
      read(rpc.summary.$get({ query }, { init: { signal } })),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    enabled: !invalid,
  });
  const data = report.data;
  const buckets = useMemo(
    () => (data ? reportBuckets(data, trendInterval(data)) : []),
    [data],
  );
  const totals = data?.totals;
  const previous = data?.previous;
  const currency = data?.ranking.currency ?? "";
  const currencies = [
    ...new Set([
      ...Object.keys(data?.currencies ?? {}).filter(Boolean),
      ...(currency ? [currency] : []),
    ]),
  ].sort();
  const tokens = totals ? tokenTotal(totals) : null;
  const cost = data ? knownCost(data, currency) : null;
  const days =
    data && data.range.period !== "total"
      ? (data.range.to - data.range.from) / DAY_MS
      : null;
  const href = (overrides: RequestDrilldownFilters = {}) =>
    data ? requestsHref(query, data.range, overrides) : "/requests";
  return (
    <div className="overview flex min-w-0 flex-col gap-5">
      <PageHeading
        title="Usage overview"
        description="Traffic, reliability, and spend · Responses & Messages inference"
      >
        {data && !report.isPlaceholderData && !invalid ? (
          <Button variant="outline" asChild>
            <Link to={href()}>
              View requests
              <ArrowRight />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            View requests
            <ArrowRight />
          </Button>
        )}
      </PageHeading>
      <ReportFilters
        timeZone={data?.range.time_zone}
        range={data?.range}
        refresh={() => void report.refetch()}
        fetching={report.isFetching}
      />
      {report.error && (
        <ErrorNotice error={report.error} retry={() => void report.refetch()} />
      )}
      {report.isPlaceholderData && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating filters… Showing the previous report until the new result
          arrives.
        </p>
      )}
      {invalid ? null : report.isPending ? (
        <Loading />
      ) : (
        data &&
        totals && (
          <div
            className="flex min-w-0 flex-col gap-5"
            aria-busy={report.isFetching}
            inert={report.isPlaceholderData}
          >
            {currencies.length > 1 && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <Choice
                  label="Cost currency"
                  value={currency}
                  onChange={(value) => change("cost_currency", value)}
                  options={currencies.map((value) => ({
                    value,
                    label: data.currencies[value]
                      ? value
                      : value + " · no data",
                  }))}
                  className="h-8 min-w-24"
                />
                <span>
                  Costs shown in {currency}. Traffic includes all currencies.
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <MetricCard
                title="Requests"
                value={number(totals.requests_count)}
                comparison={comparisonLabel(
                  totals.requests_count,
                  previous?.totals.requests_count ?? null,
                )}
                icon={<Activity />}
                sparkline={buckets.map(
                  (bucket) => bucket.totals.requests_count,
                )}
              >
                <Link className={logLink} to={href({ outcome: "pending" })}>
                  {number(data.pending)} pending
                </Link>
                <p className="mt-1">
                  {days
                    ? compact(totals.requests_count / days) + " / day avg."
                    : "Completed inference requests"}
                </p>
              </MetricCard>
              <MetricCard
                title="Success rate"
                value={percentage(
                  ratio(totals.success_count, totals.requests_count),
                )}
                comparison={comparisonLabel(
                  ratio(totals.success_count, totals.requests_count),
                  previous
                    ? ratio(
                        previous.totals.success_count,
                        previous.totals.requests_count,
                      )
                    : null,
                  true,
                )}
                icon={<CircleCheck />}
                sparkline={buckets.map((bucket) =>
                  ratio(
                    bucket.totals.success_count,
                    bucket.totals.requests_count,
                  ),
                )}
              >
                <Link className={logLink} to={href({ outcome: "failed" })}>
                  {number(totals.failed_count)} failed
                </Link>
                <p className="mt-1">
                  <Link className={logLink} to={href({ outcome: "cancelled" })}>
                    {number(totals.cancelled_count)} cancelled
                  </Link>
                  {" · "}
                  <Link
                    className={logLink}
                    to={href({ outcome: "incomplete" })}
                  >
                    {number(totals.incomplete_count)} incomplete
                  </Link>
                </p>
              </MetricCard>
              <MetricCard
                title="Reported tokens"
                value={compact(tokens)}
                comparison={comparisonLabel(
                  tokens,
                  previous ? tokenTotal(previous.totals) : null,
                )}
                icon={<Layers />}
                sparkline={
                  tokens === null
                    ? []
                    : buckets.map((bucket) =>
                        metricValue(bucket, "tokens", currency),
                      )
                }
              >
                <span>
                  {compact(tokens === null ? null : totals.input_tokens)} input
                  · {compact(tokens === null ? null : totals.output_tokens)}{" "}
                  output
                </span>
                <p className="mt-1">
                  {days && tokens !== null
                    ? compact(tokens / days) + " / day avg."
                    : "Input + output · known counters"}
                </p>
              </MetricCard>
              <MetricCard
                title="Known cost"
                value={money(cost, currency)}
                comparison={comparisonLabel(
                  cost,
                  previous ? knownCost(previous, currency) : null,
                )}
                icon={<Coins />}
                sparkline={
                  cost === null
                    ? []
                    : buckets.map((bucket) =>
                        metricValue(bucket, "cost", currency),
                      )
                }
              >
                <span>
                  {currency || "No priced usage"}
                  {days && cost !== null
                    ? " · " + money(cost / days, currency) + " / day avg."
                    : ""}
                </span>
                <p className="mt-1">
                  <Link
                    className={logLink}
                    to={href({ quality: "incomplete_pricing" })}
                  >
                    {number(totals.unpriced_count)} pricing gaps overall
                  </Link>
                </p>
              </MetricCard>
            </div>
            <Efficiency data={data} />
            {data.partial_history && (
              <Alert>
                <Info />
                <AlertTitle>Some historical detail has expired</AlertTitle>
                <AlertDescription>
                  Partial hours outside the {data.retention.days}-day detail
                  retention window may be incomplete. Use whole UTC hours for an
                  exact historical range. Period comparison is unavailable for
                  this selection.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
              <UsageTrend
                data={data}
                metric={metric}
                setMetric={setMetric}
                currency={currency}
              />
              <TokenComposition totals={totals} />
            </div>
            <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
              <OutcomeTimeline data={data} filters={query} />
              <SourceRanking data={data} filters={query} change={change} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <Coverage data={data} />
              <div className="flex flex-wrap gap-3">
                {totals.missing_usage_count > 0 && (
                  <Link
                    className={logLink}
                    to={href({ quality: "missing_usage" })}
                  >
                    {number(totals.missing_usage_count)} with incomplete usage
                  </Link>
                )}
                {totals.unpriced_count > 0 && (
                  <Link
                    className={logLink}
                    to={href({ quality: "incomplete_pricing" })}
                  >
                    {number(totals.unpriced_count)} with incomplete pricing
                  </Link>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {data.range.period === "total"
                ? "All time through "
                : date(data.range.from, data.range.time_zone) + " – "}
              {date(data.range.to, data.range.time_zone)} · Report refreshed{" "}
              {date(data.updated_at, data.range.time_zone)}. Usage arrives
              asynchronously. Known cost is not an invoice total.
            </p>
          </div>
        )
      )}
    </div>
  );
}
