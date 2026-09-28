/** Stable wire values shared by runtime schemas and consumers. */

export const HealthScope = {
  Inference: "inference",
  Catalog: "catalog",
} as const;

export type HealthScope = (typeof HealthScope)[keyof typeof HealthScope];

export const HealthFailureScope = {
  Provider: "provider",
  Credential: "credential",
} as const;

export type HealthFailureScope =
  (typeof HealthFailureScope)[keyof typeof HealthFailureScope];

export const HealthCooldownReason = {
  Quota: "quota",
} as const;

export type HealthCooldownReason =
  (typeof HealthCooldownReason)[keyof typeof HealthCooldownReason];

export const ProviderAvailabilityReason = {
  Available: "available",
  Cooling: "cooling",
  HealthReadFailed: "health_read_failed",
} as const;

export type ProviderAvailabilityReason =
  (typeof ProviderAvailabilityReason)[keyof typeof ProviderAvailabilityReason];
