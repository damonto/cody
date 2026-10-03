import {
  modelPricesSchema,
  rateSchema,
  reportingSchema,
  validateModelPriceReferences,
} from "./schema.ts";
import type { ModelPrice, ReportingConfig } from "./types.ts";

export const DEFAULT_REPORTING: ReportingConfig = {
  time_zone: "Asia/Shanghai",
  retention_days: 120,
};

export function parseRate(value: unknown, _path = "price"): string {
  return rateSchema.parse(value);
}

export function parseReporting(value: unknown): ReportingConfig {
  return reportingSchema.parse(value === undefined ? DEFAULT_REPORTING : value);
}

export function parseModelPrices(
  value: unknown,
  providers: readonly { id: string; models: string[] }[],
): ModelPrice[] {
  return modelPricesSchema
    .superRefine((prices, context) =>
      validateModelPriceReferences(prices, providers, context),
    )
    .parse(value === undefined ? [] : value);
}
