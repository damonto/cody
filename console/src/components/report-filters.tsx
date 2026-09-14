import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import { RefreshCw } from "lucide-react";
import { Choice, ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { read, rpc } from "@/lib/api";
import { useReportFilters } from "@/hooks/use-report-filters";
import {
  DAY_MS,
  reportRange,
  type ReportRange,
} from "../../../src/reporting/ranges";
export { useReportFilters } from "@/hooks/use-report-filters";
export function ReportFilters({
  refresh,
  fetching = false,
  requests = false,
  timeZone,
  range,
}: {
  refresh: () => void;
  fetching?: boolean;
  requests?: boolean;
  timeZone?: string;
  range?: ReportRange;
}) {
  const { values, change, apply, invalid, reset } = useReportFilters();
  const query = {
    period: values.period,
    from: values.from,
    to: values.to,
    time_zone: values.time_zone,
    provider_id: values.provider_id,
  };
  const options = useQuery({
    queryKey: ["report-options", query],
    queryFn: ({ signal }) =>
      read(rpc["report-options"].$get({ query }, { init: { signal } })),
    staleTime: 60_000,
    enabled: !invalid,
  });
  const zone =
    timeZone ?? options.data?.time_zone ?? values.time_zone ?? "Asia/Shanghai";
  const choices = (items: string[] | undefined, selected?: string) =>
    [...new Set([...(items ?? []), ...(selected ? [selected] : [])])]
      .sort()
      .map((value) => ({ value, label: value }));
  const period = (value: string) => {
    if (value !== "custom") return change("period", value);
    const to = range?.to ?? Date.now();
    const from =
      range && range.period !== "total" ? range.from : to - 7 * DAY_MS;
    apply({ period: "custom", from: String(from), to: String(to) });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={values.period} onValueChange={period}>
          <TabsList className="max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto">
            {[
              ["day", "Today"],
              ["week", "This week"],
              ["month", "This month"],
              ["7d", "Last 7 days"],
              ["30d", "Last 30 days"],
              ["total", "Total"],
              ["custom", "Custom"],
            ].map(([value, title]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-8 flex-none px-2"
              >
                {title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{zone}</span>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh report"
            onClick={() => {
              refresh();
              void options.refetch();
            }}
            disabled={Boolean(invalid) || fetching || options.isFetching}
          >
            <RefreshCw className={fetching ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Choice
          label="Filter by provider"
          value={values.provider_id ?? ""}
          onChange={(value) => change("provider_id", value)}
          options={[
            { value: "", label: "All providers" },
            ...choices(options.data?.providers, values.provider_id),
          ]}
        />
        <Choice
          label="Filter by model"
          value={values.model ?? ""}
          onChange={(value) => change("model", value)}
          options={[
            { value: "", label: "All models" },
            ...choices(options.data?.models, values.model),
          ]}
        />
        <Choice
          label="Filter by client"
          value={values.client_id ?? ""}
          onChange={(value) => change("client_id", value)}
          options={[
            { value: "", label: "All clients" },
            ...choices(options.data?.clients, values.client_id),
          ]}
        />
        {requests && (
          <>
            <Choice
              label="Filter by data quality"
              value={values.quality ?? ""}
              onChange={(value) => change("quality", value)}
              options={[
                { value: "", label: "All data quality" },
                { value: "missing_usage", label: "Missing / partial usage" },
                { value: "incomplete_pricing", label: "Incomplete pricing" },
              ]}
            />
            {values.currency && (
              <Choice
                label="Filter by currency"
                value={values.currency}
                onChange={(value) => change("currency", value)}
                options={[
                  { value: "", label: "All currencies" },
                  { value: values.currency, label: values.currency },
                ]}
              />
            )}
            <Choice
              label="Filter by outcome"
              value={values.outcome ?? ""}
              onChange={(value) => change("outcome", value)}
              options={[
                { value: "", label: "All outcomes" },
                ...[
                  "success",
                  "failed",
                  "pending",
                  "cancelled",
                  "incomplete",
                ].map((value) => ({
                  value,
                  label: value[0].toUpperCase() + value.slice(1),
                })),
              ]}
            />
          </>
        )}
      </div>
      {values.period === "custom" && values.from && values.to && (
        <CustomRange
          key={values.from + "/" + values.to + "/" + zone}
          from={Number(values.from)}
          to={Number(values.to)}
          timeZone={zone}
          apply={(from, to) =>
            apply({ period: "custom", from: String(from), to: String(to) })
          }
        />
      )}
      {invalid && <ErrorNotice error={invalid} retry={reset} />}
      {options.error && (
        <ErrorNotice
          error={options.error}
          retry={() => void options.refetch()}
        />
      )}
    </div>
  );
}

function localTime(time: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(time)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}

function CustomRange({
  from,
  to,
  timeZone,
  apply,
}: {
  from: number;
  to: number;
  timeZone: string;
  apply: (from: number, to: number) => void;
}) {
  const [start, setStart] = useState(() => localTime(from, timeZone));
  const [end, setEnd] = useState(() => localTime(to, timeZone));
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const epoch = (value: string) =>
            Temporal.PlainDateTime.from(value).toZonedDateTime(timeZone, {
              disambiguation: "reject",
            }).epochMilliseconds;
          const bounds = reportRange("custom", timeZone, Date.now(), {
            from: epoch(start),
            to: epoch(end),
          });
          setError("");
          apply(bounds.from, bounds.to);
        } catch (failure) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Choose valid dates in the reporting time zone",
          );
        }
      }}
    >
      <label className="min-w-0 flex-[1_1_14rem] space-y-1 text-xs">
        <span>From · {timeZone}</span>
        <Input
          required
          type="datetime-local"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </label>
      <label className="min-w-0 flex-[1_1_14rem] space-y-1 text-xs">
        <span>To · {timeZone}</span>
        <Input
          required
          type="datetime-local"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </label>
      <Button type="submit" variant="outline">
        Apply range
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
