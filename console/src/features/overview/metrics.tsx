import type { ReactNode } from "react";
import { Area, AreaChart } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { ChartContainer } from "@/components/ui/chart";
import { compact, duration, number } from "@/lib/format";
import type { Summary } from "@/lib/api";
import { cacheShare, percentage, ratio, tokenTotal } from "./data";

export function MetricCard({
  title,
  value,
  comparison,
  icon,
  sparkline,
  children,
}: {
  title: string;
  value: ReactNode;
  comparison: string;
  icon: ReactNode;
  sparkline: (number | null)[];
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-0 py-0 shadow-none" aria-label={title}>
      <CardContent className="p-4 lg:p-5">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{title}</span>
          <span className="[&>svg]:size-4">{icon}</span>
        </div>
        <div className="mt-3 wrap-break-word text-xl font-semibold tracking-tight tabular-nums sm:text-2xl xl:text-3xl">
          {value}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">{comparison}</p>
        {sparkline.some((point) => point !== null) ? (
          <ChartContainer
            config={{ value: { color: "var(--overview-accent)" } }}
            className="my-3 h-10 w-full"
            aria-label={title + " trend"}
          >
            <AreaChart
              data={sparkline.map((value, index) => ({ value, index }))}
              margin={{ top: 3, bottom: 3, left: 1, right: 1 }}
              accessibilityLayer={false}
            >
              <Area
                dataKey="value"
                type="linear"
                stroke="var(--color-value)"
                fill="var(--color-value)"
                fillOpacity={0.07}
                strokeWidth={1.6}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="my-3 h-10" aria-hidden />
        )}
        <div className="min-h-10 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

export function Efficiency({ data }: { data: Summary }) {
  const { totals } = data;
  const tokens = tokenTotal(totals);
  const minutes =
    data.range.period === "total"
      ? null
      : (data.range.to - data.range.from) / 60_000;
  const firstText = totals.first_text_samples
    ? totals.first_text_sum / totals.first_text_samples
    : null;
  const firstResponse = totals.first_response_samples
    ? totals.first_response_sum / totals.first_response_samples
    : null;
  const generation = totals.ttft_samples
    ? totals.ttft_sum / totals.ttft_samples
    : null;
  const items = [
    {
      title: "Cache read share",
      value: percentage(cacheShare(totals)),
      note: "Of reported input tokens",
    },
    {
      title: "Avg. first response",
      value: duration(firstResponse),
      note: number(totals.first_response_samples) + " reported samples",
      detail:
        "First upstream stream data, including lifecycle events. Avg. first generation: " +
        duration(generation) +
        ". Avg. first text: " +
        duration(firstText) +
        ".",
    },
    {
      title: "Avg. duration",
      value: duration(
        totals.duration_samples
          ? totals.duration_sum / totals.duration_samples
          : null,
      ),
      note: "Start to completion · incl. retries",
    },
    {
      title: "Avg. RPM",
      value: minutes ? (totals.requests_count / minutes).toFixed(2) : "—",
      note: minutes
        ? "Avg. TPM " + (tokens === null ? "—" : compact(tokens / minutes))
        : "Choose a period to see rates",
    },
  ];
  return (
    <div
      className="grid grid-cols-2 gap-y-4 rounded-xl border bg-card py-4 xl:grid-cols-4"
      aria-label="Efficiency"
    >
      {items.map((item, index) => (
        <div
          key={item.title}
          className={
            "min-w-0 px-4 lg:px-5 " +
            (index % 2 ? "border-l" : index ? "xl:border-l" : "")
          }
        >
          <p className="text-xs text-muted-foreground" title={item.detail}>
            {item.title}
          </p>
          <p className="mt-1 text-xl font-medium tracking-tight tabular-nums">
            {item.value}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">{item.note}</p>
        </div>
      ))}
    </div>
  );
}

export function Coverage({ data }: { data: Summary }) {
  const { totals } = data;
  return (
    <span>
      Usage coverage{" "}
      {percentage(
        ratio(
          totals.requests_count - totals.missing_usage_count,
          totals.requests_count,
        ),
      )}
      {" · "}Pricing coverage{" "}
      {percentage(
        ratio(
          totals.requests_count - totals.unpriced_count,
          totals.requests_count,
        ),
      )}
    </span>
  );
}
