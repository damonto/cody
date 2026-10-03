import { object as record } from "./json.ts";
import type { QuotaSnapshot } from "../oauth/schema.ts";
import { OAuthError } from "../oauth/schema.ts";

export interface XaiBilling {
  usagePercent: number | null;
  periodType: string | null;
  periodEnd: string | null;
  monthlyLimit: number | null;
  includedUsed: number | null;
  totalUsed: number | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  prepaidBalance: number | null;
  billingPeriodEnd: string | null;
  products: { product: string; used_percent: number | null }[];
}

interface BillingQuotaInput {
  credits: XaiBilling | null;
  monthly?: XaiBilling | null;
  subscriptionError?: string | null;
  monthlyError?: string | null;
  subscription?: QuotaSnapshot["subscription"];
  settingsError?: string | null;
  allowAccess?: boolean | null;
}

function number(value: unknown): number | null {
  const object = record(value);
  const raw = object.val ?? object.value ?? value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  const result = Number(raw);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function numberField(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
) {
  return number(value[snake]) ?? number(value[camel]);
}

function cents(value: unknown): number | null {
  // Grok Build's Cent is a protobuf message: an explicit {} encodes val = 0.
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Object.keys(value).length
  )
    return 0;
  return number(value);
}

function centsField(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
) {
  return cents(value[snake]) ?? cents(value[camel]);
}

function date(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

export function parseBilling(value: unknown): XaiBilling {
  const root = record(value);
  const billing = record(root.config ?? root);
  const usage = record(billing.usage);
  const period = record(billing.current_period ?? billing.currentPeriod);
  const cycle = record(billing.billing_cycle ?? billing.billingCycle);
  const productUsage = billing.product_usage ?? billing.productUsage;
  const result: XaiBilling = {
    usagePercent: numberField(
      billing,
      "credit_usage_percent",
      "creditUsagePercent",
    ),
    periodType:
      typeof period.type === "string" && period.type.trim()
        ? period.type
        : null,
    periodEnd: date(period.end),
    monthlyLimit: centsField(billing, "monthly_limit", "monthlyLimit"),
    includedUsed: centsField(usage, "included_used", "includedUsed"),
    totalUsed:
      cents(billing.used) ?? centsField(usage, "total_used", "totalUsed"),
    onDemandCap: centsField(billing, "on_demand_cap", "onDemandCap"),
    onDemandUsed:
      centsField(billing, "on_demand_used", "onDemandUsed") ??
      centsField(usage, "on_demand_used", "onDemandUsed"),
    prepaidBalance: centsField(billing, "prepaid_balance", "prepaidBalance"),
    billingPeriodEnd:
      date(billing.billing_period_end) ??
      date(billing.billingPeriodEnd) ??
      date(cycle.billing_period_end) ??
      date(cycle.billingPeriodEnd),
    products: (Array.isArray(productUsage) ? productUsage : []).flatMap(
      (entry) => {
        const product = record(entry);
        if (typeof product.product !== "string" || !product.product.trim())
          return [];
        return [
          {
            product: product.product,
            used_percent: numberField(product, "usage_percent", "usagePercent"),
          },
        ];
      },
    ),
  };
  const { products, ...fields } = result;
  if (
    !products.length &&
    Object.values(fields).every((field) => field === null)
  )
    throw new OAuthError("Invalid xAI billing response", 502, "quota_unknown");
  return result;
}

export function billingQuota({
  credits,
  monthly = null,
  subscriptionError = null,
  monthlyError = null,
  subscription = null,
  settingsError = null,
  allowAccess = null,
}: BillingQuotaInput): QuotaSnapshot {
  // Two successful requests can straddle a billing rollover. Never combine their amounts.
  const supplemental =
    credits?.billingPeriodEnd &&
    monthly?.billingPeriodEnd &&
    Date.parse(credits.billingPeriodEnd) !==
      Date.parse(monthly.billingPeriodEnd)
      ? null
      : monthly;
  const monthlyLimit =
    credits?.monthlyLimit ?? supplemental?.monthlyLimit ?? null;
  const includedUsed =
    credits?.includedUsed ??
    credits?.totalUsed ??
    supplemental?.includedUsed ??
    supplemental?.totalUsed ??
    null;
  const onDemandCap = credits?.onDemandCap ?? supplemental?.onDemandCap ?? null;
  const overage = (used: number | null | undefined) =>
    used != null && monthlyLimit !== null
      ? Math.max(0, used - monthlyLimit)
      : null;
  const onDemandUsed =
    credits?.onDemandUsed ??
    overage(credits?.totalUsed) ??
    supplemental?.onDemandUsed ??
    overage(supplemental?.totalUsed);
  // Subscription availability and resets must come from the credits response alone.
  const usedPercent = credits?.usagePercent ?? null;
  const window = credits?.periodType ?? "subscription";
  return {
    xai_billing: {
      monthly_limit: monthlyLimit,
      included_used:
        includedUsed !== null && monthlyLimit !== null
          ? Math.min(includedUsed, monthlyLimit)
          : includedUsed,
      billing_period_end:
        credits?.billingPeriodEnd ?? supplemental?.billingPeriodEnd ?? null,
      products: credits?.products.length
        ? credits.products
        : (supplemental?.products ?? []),
      subscription_error: subscriptionError,
      monthly_error: monthlyError,
      settings_error: settingsError,
      allow_access: allowAccess,
      prepaid_balance: credits?.prepaidBalance ?? null,
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
            used_percent: usedPercent,
            remaining_fraction:
              usedPercent === null ? null : Math.max(0, 1 - usedPercent / 100),
            reset_at: credits?.periodEnd ?? null,
          },
        ],
      },
    ],
    subscription,
    updated_at: Date.now(),
    last_error: null,
    stale: false,
    extra_usage:
      onDemandCap !== null
        ? {
            is_enabled: onDemandCap > 0,
            monthly_limit: onDemandCap,
            used_credits: onDemandUsed,
            utilization:
              onDemandUsed === null
                ? null
                : onDemandCap > 0
                  ? (onDemandUsed / onDemandCap) * 100
                  : 100,
            currency: "USD",
          }
        : null,
  };
}
