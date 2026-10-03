import { object as record } from "./json.ts";
import type { QuotaSnapshot } from "../oauth/schema.ts";
import { OAuthError } from "../oauth/schema.ts";

function field(value: Record<string, unknown>, snake: string, camel: string) {
  return value[snake] ?? value[camel];
}
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const object = record(value);
  const raw = object.val ?? object.value ?? value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const result = Number(raw);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function date(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}
export function parseBilling(value: unknown): QuotaSnapshot {
  const root = record(value);
  const billing = record(root.config ?? root);
  const billingField = (snake: string, camel: string) =>
    field(billing, snake, camel);
  const usageField = (snake: string, camel: string) =>
    field(record(billing.usage), snake, camel);
  const period = record(billingField("current_period", "currentPeriod"));
  const percent = number(
    billingField("credit_usage_percent", "creditUsagePercent"),
  );
  if (percent === null)
    throw new OAuthError(
      "xAI subscription quota is unavailable",
      503,
      "quota_unknown",
    );
  const window =
    typeof period.type === "string" && period.type
      ? period.type
      : "subscription";
  const monthly = number(billingField("monthly_limit", "monthlyLimit"));
  const included =
    number(usageField("included_used", "includedUsed")) ??
    number(billingField("used", "used"));
  const cycle = record(billingField("billing_cycle", "billingCycle"));
  const reset = date(
    billingField("billing_period_end", "billingPeriodEnd") ??
      field(cycle, "billing_period_end", "billingPeriodEnd"),
  );
  const cap = number(billingField("on_demand_cap", "onDemandCap"));
  const spent =
    number(billingField("on_demand_used", "onDemandUsed")) ??
    number(usageField("on_demand_used", "onDemandUsed"));
  const productUsage = billingField("product_usage", "productUsage");
  return {
    xai_billing: {
      monthly_limit: monthly,
      included_used: included,
      billing_period_end: reset,
      products: (Array.isArray(productUsage) ? productUsage : []).map(
        (entry) => {
          const product = record(entry);
          return {
            product:
              typeof product.product === "string" ? product.product : "Product",
            used_percent: number(
              field(product, "usage_percent", "usagePercent"),
            ),
          };
        },
      ),
    },
    groups: [
      {
        id: window,
        label: "Subscription credits",
        buckets: [
          {
            id: window,
            label: "Subscription credits",
            window,
            used_percent: percent,
            remaining_fraction: Math.max(0, 1 - percent / 100),
            reset_at: date(period.end),
          },
        ],
      },
    ],
    subscription: null,
    updated_at: Date.now(),
    last_error: null,
    stale: false,
    extra_usage:
      cap !== null && spent !== null
        ? {
            is_enabled: cap > 0,
            monthly_limit: cap,
            used_credits: spent,
            utilization: cap > 0 ? (spent / cap) * 100 : 100,
            currency: "USD",
          }
        : null,
  };
}
