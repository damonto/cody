import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, Coins, Layers } from "lucide-react";
import { read, rpc, params, useDraft, type UsageEvent } from "@/lib/api";
import { compact, date, duration, label, money, number } from "@/lib/format";
import {
  CopyButton,
  DataTable,
  DetailLink,
  ErrorNotice,
  Loading,
  PageHeading,
  Status,
  type DataColumn,
} from "@/components/common";
import { ReportFilters, useReportFilters } from "@/components/report-filters";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";

export default function Requests() {
  const { values, invalid } = useReportFilters();
  const draft = useDraft();
  const [cursor, setCursor] = useState<{ filter: string; history: string[] }>({
    filter: "",
    history: [""],
  });
  const filter = params(values);
  const history = cursor.filter === filter ? cursor.history : [""];
  const current = history.at(-1) ?? "";
  const [selected, setSelected] = useState<string | null>(null);
  const report = useQuery({
    queryKey: ["requests", filter, current],
    queryFn: ({ signal }) =>
      read(
        rpc.requests.$get(
          { query: { ...values, cursor: current || undefined } },
          { init: { signal } },
        ),
      ),
    refetchInterval: 15_000,
    enabled: !invalid,
  });
  const timeZone =
    report.data?.range?.time_zone ?? draft.data?.config.reporting?.time_zone;
  const columns = useMemo<DataColumn<UsageEvent>[]>(
    () => [
      {
        id: "request",
        header: "Request / started",
        cell: ({ row }) => (
          <div>
            <DetailLink onClick={() => setSelected(row.original.request_id)}>
              <span className="font-mono text-xs">
                {row.original.request_id.slice(0, 12)}
              </span>
            </DetailLink>
            <p className="mt-1 whitespace-nowrap text-[11px] text-muted-foreground">
              {date(row.original.started_at, timeZone)}
            </p>
          </div>
        ),
      },
      {
        id: "route",
        header: "Provider / model",
        cell: ({ row }) => (
          <div className="max-w-52">
            <p className="truncate font-medium">
              {row.original.provider_id || "Unrouted"}
            </p>
            <p
              className="truncate text-xs text-muted-foreground"
              title={row.original.model}
            >
              {row.original.model ||
                row.original.requested_model ||
                row.original.endpoint}
            </p>
          </div>
        ),
      },
      {
        id: "status",
        header: "Outcome",
        cell: ({ row }) => <Status value={row.original.outcome} />,
      },
      {
        id: "first_response",
        header: "First response",
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">
            {duration(row.original.first_response_ms)}
          </span>
        ),
      },
      {
        id: "duration",
        header: "Duration",
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">
            {duration(row.original.duration_ms)}
          </span>
        ),
      },
      ...(
        [
          ["input_tokens", "Input"],
          ["output_tokens", "Output"],
          ["cache_read_tokens", "Cache read"],
          ["cache_write_tokens", "Cache write"],
          ["reasoning_tokens", "Reasoning"],
        ] as const
      ).map(([key, title]) => ({
        id: key,
        header: title,
        cell: ({ row }: { row: { original: UsageEvent } }) => (
          <span className="tabular-nums">
            {number(row.original.usage.tokens[key])}
          </span>
        ),
      })),
      {
        id: "context",
        header: "Context / window",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs tabular-nums">
            {compact(row.original.context_tokens)} /{" "}
            {compact(row.original.context_window)}
          </span>
        ),
      },
      {
        id: "cost",
        header: "Cost",
        cell: ({ row }) => (
          <div className="whitespace-nowrap">
            <p className="tabular-nums">
              {money(
                row.original.billing.total_nano,
                row.original.billing.currency,
              )}
            </p>
            <p className="text-[11px] capitalize text-muted-foreground">
              {label(row.original.billing.status)}
            </p>
          </div>
        ),
      },
    ],
    [timeZone],
  );
  return (
    <>
      <PageHeading
        title="Request log"
        description="Inspect timing, token usage, context, and the price applied to each retained request."
      />
      <ReportFilters
        timeZone={timeZone}
        range={report.data?.range}
        requests
        fetching={report.isFetching}
        refresh={() => void report.refetch()}
      />
      {report.error && (
        <ErrorNotice error={report.error} retry={() => void report.refetch()} />
      )}
      {report.data?.range && (
        <p className="text-xs text-muted-foreground">
          {report.data.range.period === "total"
            ? "All time through "
            : date(report.data.range.from, timeZone) + " – "}
          {date(report.data.range.to, timeZone)}
          {report.data.retention &&
          report.data.range.from < report.data.retention.from
            ? " · Request details are retained for " +
              report.data.retention.days +
              " days; older aggregates remain in Overview."
            : ""}
        </p>
      )}
      <Card className="overflow-hidden py-0 shadow-none">
        {report.isPending && !invalid ? (
          <Loading />
        ) : (
          <DataTable
            data={report.data?.items ?? []}
            columns={columns}
            empty="No requests in this period"
          />
        )}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground">
        <span>
          Unknown counters are shown as —. Input includes caches; Output
          includes Reasoning.
        </span>
        <div className="flex items-center gap-3">
          <span>Page {history.length}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={history.length <= 1 || report.isFetching}
            onClick={() => setCursor({ filter, history: history.slice(0, -1) })}
          >
            <ChevronLeft />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!report.data?.next_cursor || report.isFetching}
            onClick={() => {
              if (report.data?.next_cursor)
                setCursor({
                  filter,
                  history: [...history, report.data.next_cursor],
                });
            }}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-2xl">
          <SheetHeader className="border-b p-6">
            <SheetTitle>Request details</SheetTitle>
            <SheetDescription>
              Usage and pricing captured when the request ran.
            </SheetDescription>
          </SheetHeader>
          {selected && <RequestDetail id={selected} timeZone={timeZone} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
function Details({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="divide-y">
      {rows.map(([title, value]) => (
        <div
          key={title}
          className="flex items-start justify-between gap-6 py-3 text-sm"
        >
          <dt className="shrink-0 text-muted-foreground">{title}</dt>
          <dd className="min-w-0 break-all text-right font-medium tabular-nums">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function RequestDetail({ id, timeZone }: { id: string; timeZone?: string }) {
  const detail = useQuery({
    queryKey: ["request", id],
    queryFn: ({ signal }) =>
      read(rpc.requests[":id"].$get({ param: { id } }, { init: { signal } })),
    refetchInterval: (query) =>
      query.state.data?.phase === "started" ? 5_000 : false,
  });
  if (detail.isPending) return <Loading />;
  if (detail.error)
    return (
      <div className="p-6">
        <ErrorNotice error={detail.error} />
      </div>
    );
  const item = detail.data;
  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <Status value={item.outcome} />
        <span className="text-xs text-muted-foreground">
          {item.protocol} · {item.transport}
        </span>
      </div>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs">
          {item.request_id}
        </code>
        <CopyButton value={item.request_id} title="Copy request ID" />
      </div>
      <Tabs defaultValue="usage">
        <TabsList className="w-full">
          <TabsTrigger value="usage">
            <Layers />
            Usage
          </TabsTrigger>
          <TabsTrigger value="billing">
            <Coins />
            Pricing
          </TabsTrigger>
          <TabsTrigger value="routing">
            <Clock />
            Routing & attempts
          </TabsTrigger>
        </TabsList>
        <TabsContent value="usage">
          <Details
            rows={[
              ["Started", date(item.started_at, timeZone)],
              ["First response", duration(item.first_response_ms)],
              ["First generation event", duration(item.ttft_ms)],
              ["First text", duration(item.first_text_ms)],
              ["Total duration", duration(item.duration_ms)],
              [
                "Usage status",
                <Status key="usage-status" value={item.usage.status} />,
              ],
              [
                "Input (including caches)",
                number(item.usage.tokens.input_tokens),
              ],
              [
                "Uncached input",
                number(item.usage.tokens.uncached_input_tokens),
              ],
              [
                "Output (including reasoning)",
                number(item.usage.tokens.output_tokens),
              ],
              ["Cache read", number(item.usage.tokens.cache_read_tokens)],
              ["Cache write", number(item.usage.tokens.cache_write_tokens)],
              [
                "Cache write · 5 minutes",
                number(item.usage.tokens.cache_write_5m_tokens),
              ],
              [
                "Cache write · 1 hour",
                number(item.usage.tokens.cache_write_1h_tokens),
              ],
              ["Reasoning", number(item.usage.tokens.reasoning_tokens)],
              ["Context size", compact(item.context_tokens)],
              ["Context window", compact(item.context_window)],
            ]}
          />
          {item.context_tokens !== null && item.context_window !== null && (
            <div className="mt-3 space-y-2">
              <Progress
                value={Math.min(
                  100,
                  (item.context_tokens / item.context_window) * 100,
                )}
              />
              <p className="text-xs text-muted-foreground">
                {((item.context_tokens / item.context_window) * 100).toFixed(1)}
                % of configured context window
              </p>
            </div>
          )}
        </TabsContent>
        <TabsContent value="billing">
          <Details
            rows={[
              [
                "Pricing status",
                <Status key="billing-status" value={item.billing.status} />,
              ],
              [
                "Known total",
                money(item.billing.total_nano, item.billing.currency),
              ],
              ["Input", money(item.billing.input_nano, item.billing.currency)],
              [
                "Output",
                money(item.billing.output_nano, item.billing.currency),
              ],
              [
                "Cache write",
                money(item.billing.cache_write_nano, item.billing.currency),
              ],
              [
                "Cache read",
                money(item.billing.cache_read_nano, item.billing.currency),
              ],
              [
                "Selected tier",
                item.billing.tier_index === null
                  ? "—"
                  : String(item.billing.tier_index + 1),
              ],
              ["Tier input size", number(item.billing.context_tokens)],
              ["Price version", item.billing.price_version ?? "—"],
              ["Configuration revision", item.config_revision ?? "—"],
            ]}
          />
          <AppliedRates
            version={item.billing.price_version}
            tierIndex={item.billing.tier_index}
          />
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Prices are snapshotted per provider and model. Editing prices does
            not recalculate historical requests. Each retry is priced
            separately; the request total includes known attempt costs.
          </p>
        </TabsContent>
        <TabsContent value="routing">
          <Details
            rows={[
              ["Client", item.client_id || "—"],
              ["Provider", item.provider_id || "—"],
              ["Upstream credential ID", item.credential_id || "—"],
              ["Requested model", item.requested_model || "—"],
              ["Routed model", item.model || "—"],
              ["Reported model", item.reported_model || "—"],
              ["Endpoint", `${item.method} /${item.endpoint}`],
              ["HTTP status", item.http_status ?? "—"],
              ["Response ID", item.response_id ?? "—"],
              ["Connection ID", item.connection_id ?? "—"],
              ["Diagnostic", item.diagnostic_code ?? "—"],
              ["Observation issue", item.observation_issue ?? "—"],
            ]}
          />
          <h3 className="mb-2 mt-6 text-sm font-medium">Upstream attempts</h3>
          <DataTable
            data={item.attempts}
            columns={[
              {
                id: "attempt",
                header: "Attempt",
                cell: ({ row }) => row.original.attempt,
              },
              {
                id: "status",
                header: "HTTP",
                cell: ({ row }) => row.original.status ?? "—",
              },
              {
                id: "duration",
                header: "Duration",
                cell: ({ row }) => duration(row.original.duration_ms),
              },
              {
                id: "delay",
                header: "Retry delay",
                cell: ({ row }) => duration(row.original.retry_delay_ms),
              },
              {
                id: "cost",
                header: "Known cost",
                cell: ({ row }) =>
                  money(
                    row.original.billing?.total_nano,
                    row.original.billing?.currency ?? "",
                  ),
              },
            ]}
            empty="No upstream attempt recorded"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AppliedRates({
  version,
  tierIndex,
}: {
  version: string | null;
  tierIndex: number | null;
}) {
  const price = useQuery({
    queryKey: ["price-version", version],
    queryFn: ({ signal }) =>
      read(
        rpc.pricing.version.$get(
          { query: { id: version ?? "" } },
          { init: { signal } },
        ),
      ),
    enabled: !!version,
    staleTime: Infinity,
  });
  if (!version) return null;
  if (price.isPending) return <Loading />;
  if (price.error) return <ErrorNotice error={price.error} />;
  const tier =
    tierIndex === null
      ? undefined
      : price.data.policy.pricing?.tiers[tierIndex];
  if (!tier) return null;
  return (
    <div className="mt-4 rounded-lg border p-4">
      <h3 className="text-sm font-medium">Applied rates per million tokens</h3>
      <Details
        rows={[
          ["Input", tier.input],
          ["Output", tier.output],
          ["Cache write", tier.cache_write],
          ["Cache read", tier.cache_read],
          ...(tier.cache_write_5m
            ? [
                ["Cache write · 5 minutes", tier.cache_write_5m] as [
                  string,
                  string,
                ],
              ]
            : []),
          ...(tier.cache_write_1h
            ? [
                ["Cache write · 1 hour", tier.cache_write_1h] as [
                  string,
                  string,
                ],
              ]
            : []),
        ]}
      />
    </div>
  );
}
