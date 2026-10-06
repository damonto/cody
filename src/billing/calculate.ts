import { validImageUsage, uncachedImageTokens } from "./image-usage.ts";
import { BillingStatus } from "./values.ts";

import { parseRate } from "./config.ts";
import type {
  CostBreakdown,
  ModelPrice,
  TokenUsage,
  PriceTier,
} from "./types.ts";

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

interface TokenCharge {
  standard: number | null;
  image: number | null;
}

function splitTokenCost(
  total: number | null,
  image: number | null,
  rate: string,
  imageRate: string | undefined,
): TokenCharge {
  // Inherited rates retain the single legacy charge and its rounding.
  if (imageRate === undefined)
    return { standard: tokenCost(total, rate), image: 0 };
  if (total === 0 && image === null) image = 0;
  if (total !== null && image !== null && image > total)
    throw new Error("Image tokens exceed total");
  return {
    standard:
      total !== null && image !== null ? tokenCost(total - image, rate) : null,
    image: tokenCost(image, imageRate),
  };
}

function ordinaryCacheWriteCost(
  usage: TokenUsage,
  tier: PriceTier,
): number | null {
  if (usage.cache_write_tokens === 0) return 0;
  if (tier.cache_write_5m === undefined && tier.cache_write_1h === undefined)
    return tokenCost(usage.cache_write_tokens, tier.cache_write);
  const short = usage.cache_write_5m_tokens;
  const long = usage.cache_write_1h_tokens;
  if (
    short === null ||
    long === null ||
    short + long !== usage.cache_write_tokens
  )
    return null;
  return (
    (tokenCost(short, tier.cache_write_5m ?? tier.cache_write) ?? 0) +
    (tokenCost(long, tier.cache_write_1h ?? tier.cache_write) ?? 0)
  );
}

function cacheWriteCost(usage: TokenUsage, tier: PriceTier): TokenCharge {
  if (tier.image_cache_write === undefined)
    return { standard: ordinaryCacheWriteCost(usage, tier), image: 0 };
  const total = usage.cache_write_tokens;
  const image =
    usage.image_cache_write_tokens ??
    (total === 0 || usage.image_input_tokens === 0 ? 0 : null);
  if (image === 0)
    return { standard: ordinaryCacheWriteCost(usage, tier), image: 0 };
  if (total !== null && image === total)
    return { standard: 0, image: tokenCost(image, tier.image_cache_write) };
  if (tier.cache_write_5m === undefined && tier.cache_write_1h === undefined)
    return splitTokenCost(
      total,
      image,
      tier.cache_write,
      tier.image_cache_write,
    );
  const rate5m = tier.cache_write_5m ?? tier.cache_write;
  const rate1h = tier.cache_write_1h ?? tier.cache_write;
  if (Number(rate5m) === Number(rate1h))
    return splitTokenCost(total, image, rate5m, tier.image_cache_write);
  const short = usage.cache_write_5m_tokens;
  const long = usage.cache_write_1h_tokens;
  if (
    short !== null &&
    long !== null &&
    total !== null &&
    short + long === total
  ) {
    if (short === 0)
      return splitTokenCost(total, image, rate1h, tier.image_cache_write);
    if (long === 0)
      return splitTokenCost(total, image, rate5m, tier.image_cache_write);
  }
  // A mixed-duration write total does not reveal the duration of its text tokens.
  return { standard: null, image: tokenCost(image, tier.image_cache_write) };
}

export function emptyCost(
  status: CostBreakdown["status"] = BillingStatus.Unpriced,
): CostBreakdown {
  return {
    status,
    currency: "",
    price_version: null,
    tier_index: null,
    context_tokens: null,
    image_input_nano: null,
    image_output_nano: null,
    image_cache_read_nano: null,
    image_cache_write_nano: null,
    input_nano: null,
    output_nano: null,
    cache_write_nano: null,
    cache_read_nano: null,
    total_nano: null,
  };
}

export function calculateCost(
  usage: TokenUsage,
  price: ModelPrice | undefined,
  version: string | null = null,
): CostBreakdown {
  if (!validImageUsage(usage)) throw new Error("Invalid image token counts");
  const result = emptyCost(
    price?.pricing ? BillingStatus.Unknown : BillingStatus.Unpriced,
  );
  result.price_version = version;
  result.context_tokens = usage.input_tokens;
  if (!price?.pricing) return result;
  const { currency, tiers } = price.pricing;
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
  const input = splitTokenCost(
    usage.uncached_input_tokens,
    uncachedImageTokens(usage),
    tier.input,
    tier.image_input,
  );
  const output = splitTokenCost(
    usage.output_tokens,
    usage.image_output_tokens,
    tier.output,
    tier.image_output,
  );
  const cacheRead = splitTokenCost(
    usage.cache_read_tokens,
    usage.image_cache_read_tokens ??
      (usage.image_input_tokens === 0 ? 0 : null),
    tier.cache_read,
    tier.image_cache_read,
  );
  result.input_nano = input.standard;
  result.image_input_nano = input.image;
  result.output_nano = output.standard;
  result.image_output_nano = output.image;
  result.cache_read_nano = cacheRead.standard;
  result.image_cache_read_nano = cacheRead.image;
  const cacheWrite = cacheWriteCost(usage, tier);
  result.cache_write_nano = cacheWrite.standard;
  result.image_cache_write_nano = cacheWrite.image;
  const parts = [
    result.input_nano,
    ...(tier.image_input === undefined ? [] : [result.image_input_nano]),
    ...(tier.image_output === undefined ? [] : [result.image_output_nano]),
    ...(tier.image_cache_read === undefined
      ? []
      : [result.image_cache_read_nano]),
    ...(tier.image_cache_write === undefined
      ? []
      : [result.image_cache_write_nano]),
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
      ? BillingStatus.Complete
      : known.length > 0
        ? BillingStatus.Partial
        : BillingStatus.Unknown;
  return result;
}
