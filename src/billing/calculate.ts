import { parseRate } from "./config.ts";
import type { CostBreakdown, ModelPolicy, TokenUsage } from "./types.ts";

export function priceVersion(
  revision: number | undefined,
  service: string,
  model: string,
): string | null {
  return revision === undefined
    ? null
    : JSON.stringify([revision, service, model]);
}

// Prices are decimal currency units per million tokens. Monetary results are
// integer nanounits, rounded half-up once per charge, never binary float sums.
export function tokenCost(tokens: number | null, rate: string): number | null {
  if (tokens === null) return null;
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new Error("Invalid token count");
  parseRate(rate);
  const [whole = "0", fraction = ""] = rate.split(".");
  const microRate =
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const nanos = (BigInt(tokens) * microRate + 500n) / 1_000n;
  if (nanos > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Cost exceeds supported monetary precision");
  return Number(nanos);
}

export function emptyCost(
  status: CostBreakdown["status"] = "unpriced",
): CostBreakdown {
  return {
    status,
    currency: "",
    price_version: null,
    tier_index: null,
    context_tokens: null,
    input_nano: null,
    output_nano: null,
    cache_write_nano: null,
    cache_read_nano: null,
    total_nano: null,
  };
}

export function calculateCost(
  usage: TokenUsage,
  policy: ModelPolicy | undefined,
  version: string | null = null,
): CostBreakdown {
  const result = emptyCost(policy?.pricing ? "unknown" : "unpriced");
  result.price_version = version;
  result.context_tokens = usage.input_tokens;
  if (!policy?.pricing) return result;
  const { currency, tiers } = policy.pricing;
  result.currency = currency;
  if (usage.input_tokens === null) return result;
  const contextTokens = usage.input_tokens;
  const tierIndex = tiers.findIndex(
    (tier) =>
      tier.up_to_input_tokens === null ||
      contextTokens <= tier.up_to_input_tokens,
  );
  const tier = tiers[tierIndex];
  if (!tier) return result;
  result.tier_index = tierIndex;
  result.input_nano = tokenCost(usage.uncached_input_tokens, tier.input);
  result.output_nano = tokenCost(usage.output_tokens, tier.output);
  result.cache_read_nano = tokenCost(usage.cache_read_tokens, tier.cache_read);
  if (usage.cache_write_tokens === 0) {
    result.cache_write_nano = 0;
  } else if (
    tier.cache_write_5m !== undefined ||
    tier.cache_write_1h !== undefined
  ) {
    if (
      usage.cache_write_5m_tokens !== null &&
      usage.cache_write_1h_tokens !== null &&
      usage.cache_write_5m_tokens + usage.cache_write_1h_tokens ===
        usage.cache_write_tokens
    ) {
      result.cache_write_nano =
        (tokenCost(
          usage.cache_write_5m_tokens,
          tier.cache_write_5m ?? tier.cache_write,
        ) ?? 0) +
        (tokenCost(
          usage.cache_write_1h_tokens,
          tier.cache_write_1h ?? tier.cache_write,
        ) ?? 0);
    }
  } else {
    result.cache_write_nano = tokenCost(
      usage.cache_write_tokens,
      tier.cache_write,
    );
  }
  const parts = [
    result.input_nano,
    result.output_nano,
    result.cache_write_nano,
    result.cache_read_nano,
  ];
  const known = parts.filter((value): value is number => value !== null);
  const total = known.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total))
    throw new Error("Cost exceeds supported monetary precision");
  result.total_nano = known.length === 0 ? null : total;
  result.status =
    known.length === parts.length
      ? "complete"
      : known.length > 0
        ? "partial"
        : "unknown";
  return result;
}
