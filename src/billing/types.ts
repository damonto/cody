import type { z } from "zod";
import type {
  modelPolicySchema,
  priceTierSchema,
  reportingSchema,
} from "./schema.ts";

export type PriceTier = z.infer<typeof priceTierSchema>;
export type ModelPolicy = z.infer<typeof modelPolicySchema>;
export type ReportingConfig = z.infer<typeof reportingSchema>;

export const USAGE_FIELDS = [
  "input_tokens",
  "uncached_input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "reasoning_tokens",
] as const;

export type UsageField = (typeof USAGE_FIELDS)[number];
export type TokenUsage = Record<UsageField, number | null>;
export type UsageStatus = "reported" | "partial" | "missing" | "invalid";

export interface NormalizedUsage {
  tokens: TokenUsage;
  status: UsageStatus;
  // Only token counters are retained. Never keep completion text or prompts.
  raw: Record<string, unknown>;
}

export interface CostBreakdown {
  status: "complete" | "partial" | "unpriced" | "unknown";
  currency: string;
  price_version: string | null;
  tier_index: number | null;
  context_tokens: number | null;
  input_nano: number | null;
  output_nano: number | null;
  cache_write_nano: number | null;
  cache_read_nano: number | null;
  total_nano: number | null;
}
