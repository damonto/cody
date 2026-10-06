import { type UsageStatus, type BillingStatus } from "./values.ts";

import type { z } from "zod";
import type {
  modelPriceSchema,
  priceTierSchema,
  reportingSchema,
} from "./schema.ts";

export type PriceTier = z.infer<typeof priceTierSchema>;
export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type ReportingConfig = z.infer<typeof reportingSchema>;

export const SQL_USAGE_FIELDS = [
  "input_tokens",
  "uncached_input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "reasoning_tokens",
] as const;

export const IMAGE_USAGE_FIELDS = [
  "image_input_tokens",
  "image_output_tokens",
  "image_cache_read_tokens",
  "image_cache_write_tokens",
] as const;
export const USAGE_FIELDS = [
  ...SQL_USAGE_FIELDS,
  ...IMAGE_USAGE_FIELDS,
] as const;

type UsageField = (typeof USAGE_FIELDS)[number];
export type TokenUsage = Record<UsageField, number | null>;

export interface NormalizedUsage {
  tokens: TokenUsage;
  status: UsageStatus;
  // Only token counters are retained. Never keep completion text or prompts.
  raw: Record<string, unknown>;
}

export interface CostBreakdown {
  status: BillingStatus;
  currency: string;
  price_version: string | null;
  tier_index: number | null;
  context_tokens: number | null;
  image_input_nano: number | null;
  image_output_nano: number | null;
  image_cache_read_nano: number | null;
  image_cache_write_nano: number | null;
  input_nano: number | null;
  output_nano: number | null;
  cache_write_nano: number | null;
  cache_read_nano: number | null;
  total_nano: number | null;
}

export const IMAGE_COST_FIELDS = [
  "image_input_nano",
  "image_output_nano",
  "image_cache_read_nano",
  "image_cache_write_nano",
] as const satisfies readonly (keyof CostBreakdown)[];
