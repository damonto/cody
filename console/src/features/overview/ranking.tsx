import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Choice, Empty } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Summary } from "@/lib/api";
import type { ChangeReportFilter } from "@/hooks/use-report-filters";
import { compact, money, number } from "@/lib/format";
import type { ReportQueryParams } from "../../../../src/reporting/query";
import {
  knownCost,
  percentage,
  metricValue,
  ratio,
  requestsHref,
  type MetricName,
} from "./data";

export function SourceRanking({
  data,
  filters,
  change,
}: {
  data: Summary;
  filters: ReportQueryParams;
  change: ChangeReportFilter;
}) {
  const ranking = data.ranking;
  const metric: MetricName = ranking.metric;
  const currency = ranking.currency;
  const denominator = metricValue(data, metric, currency);
  const rows = [
    ...ranking.items.map((row) => ({ ...row, other: false })),
    ...(ranking.other
      ? [{ ...ranking.other, value: "Other", other: true }]
      : []),
  ];
  const valueLabel =
    metric === "requests"
      ? "Requests"
      : metric === "tokens"
        ? "Tokens"
        : currency || "Cost";
  return (
    <Card className="min-w-0 gap-4 shadow-none">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle role="heading" aria-level={2}>
            Top sources
          </CardTitle>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Rank dimension"
          >
            {(
              [
                ["service_id", "Services"],
                ["model", "Models"],
                ["client_id", "Clients"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={ranking.dimension === value ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={ranking.dimension === value}
                onClick={() => change("group_by", value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <Choice
          label="Rank by"
          value={metric}
          onChange={(value) => change("sort_by", value)}
          className="h-8 w-fit text-xs"
          options={[
            { value: "requests", label: "By requests" },
            { value: "tokens", label: "By tokens" },
            { value: "cost", label: "By known cost" },
          ]}
        />
      </CardHeader>
      <CardContent>
        {rows.length &&
        (metric !== "cost" || knownCost(data, currency) !== null) ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Source</TableHead>
                <TableHead className="text-right text-xs">
                  {valueLabel}
                </TableHead>
                <TableHead className="text-right text-xs">Success</TableHead>
                <TableHead className="text-right text-xs">
                  {metric === "cost" ? "Requests" : currency || "Cost"}
                </TableHead>
                <TableHead>
                  <span className="sr-only">Request log</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const value = metricValue(row, metric, currency);
                const share =
                  denominator !== null && value !== null
                    ? ratio(value, denominator)
                    : null;
                return (
                  <TableRow
                    key={(row.other ? "other:" : "source:") + row.value}
                  >
                    <TableCell className="min-w-28 max-w-52 py-3">
                      {row.other || !row.value ? (
                        <span className="text-xs">
                          {row.value || "Unassigned"}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="max-w-full cursor-pointer break-all text-left text-xs hover:underline"
                          onClick={() => change(ranking.dimension, row.value)}
                        >
                          {row.value}
                        </button>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1 min-w-8 flex-1 rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-[var(--overview-accent)]"
                            style={{ width: `${share ?? 0}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {share === null ? "—" : `${share.toFixed(1)}%`}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {metric === "cost"
                        ? money(knownCost(row, currency), currency)
                        : metric === "requests"
                          ? number(value)
                          : compact(value)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {percentage(
                        ratio(
                          row.totals.success_count,
                          row.totals.requests_count,
                        ),
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {metric === "cost"
                        ? number(row.totals.requests_count)
                        : money(knownCost(row, currency), currency)}
                    </TableCell>
                    <TableCell className="px-1">
                      {!row.other && row.value && (
                        <Button variant="ghost" size="icon-sm" asChild>
                          <Link
                            aria-label={"View requests for " + row.value}
                            to={requestsHref(
                              { ...filters, [ranking.dimension]: row.value },
                              data.range,
                              metric === "cost" ? { currency } : {},
                            )}
                          >
                            <ArrowUpRight />
                          </Link>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <Empty
            title={
              metric === "cost"
                ? "No priced sources in this period"
                : "No sources in this period"
            }
          />
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Top 5 · shares include every source
          {currency ? " · costs in " + currency : ""}
        </p>
      </CardContent>
    </Card>
  );
}
