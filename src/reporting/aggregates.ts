export const AGGREGATE_FIELDS = [
  "requests_count",
  "success_count",
  "failed_count",
  "cancelled_count",
  "incomplete_count",
  "missing_usage_count",
  "unpriced_count",
  "input_tokens",
  "uncached_input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "reasoning_tokens",
  "reasoning_samples",
  "cost_nano",
  "duration_sum",
  "duration_samples",
  "ttft_sum",
  "ttft_samples",
  "first_text_sum",
  "first_text_samples",
] as const;

export type AggregateField = (typeof AGGREGATE_FIELDS)[number];
export type Aggregate = Record<AggregateField, number>;
export interface CurrencyTotal {
  cost_nano: number;
  unpriced_count: number;
  requests_count: number;
}
export type CurrencyTotals = Record<string, CurrencyTotal>;
export interface Rollup {
  totals: Aggregate;
  currencies: CurrencyTotals;
}
export interface SeriesRow extends Aggregate {
  hour: number;
  currency: string;
}

export function emptyAggregate(): Aggregate {
  return Object.fromEntries(
    AGGREGATE_FIELDS.map((field) => [field, 0]),
  ) as Aggregate;
}

export function summarize(
  rows: readonly (Aggregate & { currency: string })[],
): Rollup {
  const totals = emptyAggregate();
  const currencies: CurrencyTotals = {};
  for (const row of rows) {
    for (const field of AGGREGATE_FIELDS) {
      // A cross-currency total has no monetary amount.
      if (field !== "cost_nano") totals[field] += row[field];
    }
    const currency = (currencies[row.currency] ??= {
      cost_nano: 0,
      unpriced_count: 0,
      requests_count: 0,
    });
    currency.cost_nano += row.cost_nano;
    currency.unpriced_count += row.unpriced_count;
    currency.requests_count += row.requests_count;
  }
  return { totals, currencies };
}

export function defaultCurrency(currencies: CurrencyTotals): string {
  return currencies.USD
    ? "USD"
    : (Object.keys(currencies).filter(Boolean).sort()[0] ?? "");
}
