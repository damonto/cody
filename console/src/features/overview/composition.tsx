import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { compact, number } from "@/lib/format";
import type { Aggregate } from "@/lib/api";
import { tokenTotal } from "./data";

export function TokenComposition({ totals }: { totals: Aggregate }) {
  const total = tokenTotal(totals);
  const knownInput =
    totals.uncached_input_tokens +
    totals.cache_read_tokens +
    totals.cache_write_tokens;
  const inconsistent = knownInput > totals.input_tokens;
  const rows = [
    {
      label: "Uncached input",
      count: totals.uncached_input_tokens,
      color: "var(--overview-accent)",
    },
    {
      label: "Cache read",
      count: totals.cache_read_tokens,
      color: "var(--overview-cache)",
    },
    {
      label: "Cache write",
      count: totals.cache_write_tokens,
      color: "var(--overview-write)",
    },
    ...(knownInput < totals.input_tokens
      ? [
          {
            label: "Input detail unavailable",
            count: totals.input_tokens - knownInput,
            color: "var(--muted-foreground)",
          },
        ]
      : []),
    {
      label: "Output",
      count: totals.output_tokens,
      color: "var(--overview-output)",
    },
  ];
  return (
    <Card className="min-w-0 gap-4 shadow-none">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Token composition
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {compact(total)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Reported input + output
        </p>
        <div
          className="my-5 flex h-3 gap-0.5 overflow-hidden rounded-sm bg-muted"
          role="img"
          aria-label={rows
            .map(
              (row) =>
                row.label + ": " + number(total === null ? null : row.count),
            )
            .join(", ")}
        >
          {total && !inconsistent
            ? rows.map((row) => (
                <span
                  key={row.label}
                  style={{
                    width: (row.count / total) * 100 + "%",
                    background: row.color,
                  }}
                />
              ))
            : null}
        </div>
        <div className="space-y-3">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-start justify-between gap-3 text-xs"
            >
              <span className="flex items-center gap-2 text-muted-foreground">
                <span
                  className="size-2 shrink-0 rounded-sm"
                  style={{ background: row.color }}
                />
                {row.label}
              </span>
              <span className="tabular-nums">
                {compact(total === null ? null : row.count)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
          <span>Of output: reasoning</span>
          <span className="tabular-nums">
            {totals.reasoning_samples
              ? compact(totals.reasoning_tokens)
              : "Not reported"}
          </span>
        </div>
        {(totals.missing_usage_count > 0 || inconsistent) && (
          <p className="mt-3 text-xs text-muted-foreground">
            {inconsistent
              ? "Some input details are inconsistent."
              : number(totals.missing_usage_count) +
                " requests have missing or partial usage."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
