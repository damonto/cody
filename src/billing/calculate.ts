import { validImageUsage, uncachedImageTokens } from "./image-usage.ts";
import { BillingStatus } from "./values.ts";
import { CACHE_WRITE_DURATIONS } from "../shared/cache-durations.ts";
import { observedCacheDurations, validCacheWriteUsage } from "./cache-usage.ts";

import { parseRate } from "./config.ts";
import type {
  CostBreakdown,
  ModelPrice,
  TokenUsage,
  PriceTier,
} from "./types.ts";

// Prices are decimal currency units per million tokens. Monetary results are
// integer nanounits, rounded half-up once per charge, never binary float sums.
export function tokenCost(tokens: number, rate: string): number;
export function tokenCost(tokens: number | null, rate: string): number | null;
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

interface CacheWriteCharge {
  tokens: number | null;
  rate: string;
}

function cacheWriteDurationCharges(
  usage: TokenUsage,
  tier: PriceTier,
): CacheWriteCharge[] | undefined {
  const durations =
    observedCacheDurations(usage)[0]?.durations ?? CACHE_WRITE_DURATIONS;
  if (durations.every(({ price }) => tier[price] === undefined))
    return undefined;
  return durations.map(({ price, tokens }) => ({
    tokens: usage[tokens] ?? null,
    rate: tier[price] ?? tier.cache_write,
  }));
}

/** Called after duration validation; complete buckets already match the total. */
function ordinaryCacheWriteCost(
  total: number | null,
  rate: string,
  charges: readonly CacheWriteCharge[] | undefined,
): number | null {
  if (total === 0) return 0;
  if (!charges) return tokenCost(total, rate);
  if (total === null) return null;
  let cost = 0;
  for (const charge of charges) {
    if (charge.tokens === null) return null;
    cost += tokenCost(charge.tokens, charge.rate);
  }
  return cost;
}

function cacheWriteCost(usage: TokenUsage, tier: PriceTier): TokenCharge {
  const total = usage.cache_write_tokens;
  const charges = cacheWriteDurationCharges(usage, tier);
  const image =
    usage.image_cache_write_tokens ??
    (total === 0 || usage.image_input_tokens === 0 ? 0 : null);
  if (tier.image_cache_write === undefined || image === 0)
    return {
      standard: ordinaryCacheWriteCost(total, tier.cache_write, charges),
      image: 0,
    };
  if (total !== null && image === total)
    return { standard: 0, image: tokenCost(image, tier.image_cache_write) };
  if (!charges)
    return splitTokenCost(
      total,
      image,
      tier.cache_write,
      tier.image_cache_write,
    );
  const [first, ...remaining] = charges;
  if (
    first &&
    remaining.every(({ rate }) => Number(rate) === Number(first.rate))
  )
    return splitTokenCost(total, image, first.rate, tier.image_cache_write);
  if (total !== null && charges.every(({ tokens }) => tokens !== null)) {
    const nonzero = charges.filter(({ tokens }) => tokens !== 0);
    const duration = nonzero.length === 1 ? nonzero[0] : undefined;
    if (duration)
      return splitTokenCost(
        total,
        image,
        duration.rate,
        tier.image_cache_write,
      );
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
  if (!validCacheWriteUsage(usage))
    throw new Error("Invalid cache duration token counts");
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
  if (known.length === parts.length) result.status = BillingStatus.Complete;
  else if (known.length > 0) result.status = BillingStatus.Partial;
  else result.status = BillingStatus.Unknown;
  return result;
}
