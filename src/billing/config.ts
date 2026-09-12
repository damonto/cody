import {
  modelPoliciesSchema,
  rateSchema,
  reportingSchema,
  validateModelPolicyReferences,
} from "./schema.ts";
import type { ModelPolicy, ReportingConfig } from "./types.ts";

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

export function parseModelPolicies(
  value: unknown,
  services: readonly { id: string; models: string[] }[],
): ModelPolicy[] {
  return modelPoliciesSchema
    .superRefine((policies, context) =>
      validateModelPolicyReferences(policies, services, context),
    )
    .parse(value === undefined ? [] : value);
}
