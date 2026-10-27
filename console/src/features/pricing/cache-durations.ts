import {
  CACHE_WRITE_DURATION_GROUPS,
  type CacheDurationFormat,
} from "../../../../src/shared/cache-durations.ts";
import type { PriceTier } from "../../../../src/billing/types.ts";
import { ProviderType } from "../../../../src/config/values.ts";

function hasDurationPrices(
  tiers: readonly PriceTier[],
  format: CacheDurationFormat,
): boolean {
  return tiers.some((tier) =>
    CACHE_WRITE_DURATION_GROUPS[format].durations.some(
      ({ price }) => tier[price] !== undefined,
    ),
  );
}

export function pricingDurationFormats(
  providerType: ProviderType,
  tiers: readonly PriceTier[] = [],
): CacheDurationFormat[] {
  const formats: CacheDurationFormat[] = [];
  for (const format of ["openai", "anthropic"] as const) {
    const native =
      (format === "openai" && providerType === ProviderType.Codex) ||
      (format === "anthropic" && providerType === ProviderType.Claude);
    if (
      providerType === ProviderType.AiGateway ||
      native ||
      hasDurationPrices(tiers, format)
    )
      formats.push(format);
  }
  return formats;
}

export function initialPricingDurationFormat(
  providerType: ProviderType,
  tiers: readonly PriceTier[] = [],
): CacheDurationFormat | undefined {
  if (providerType === ProviderType.Codex) return "openai";
  if (providerType === ProviderType.Claude) return "anthropic";
  const formats = pricingDurationFormats(providerType, tiers);
  return (
    formats.find((format) => hasDurationPrices(tiers, format)) ?? formats[0]
  );
}
