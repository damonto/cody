/** Stable wire values shared by runtime schemas and consumers. */

export const UsageStatus = {
  Reported: "reported",
  Partial: "partial",
  Missing: "missing",
  Invalid: "invalid",
} as const;

export type UsageStatus = (typeof UsageStatus)[keyof typeof UsageStatus];

export const BillingStatus = {
  Complete: "complete",
  Partial: "partial",
  Unpriced: "unpriced",
  Unknown: "unknown",
} as const;

export type BillingStatus = (typeof BillingStatus)[keyof typeof BillingStatus];
