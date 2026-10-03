import type { QuotaSnapshot } from "../providers/oauth/schema.ts";

/** A missing percentage can be checked upstream when fresh billing rules out extra spending. */
export function canUseXaiUnreportedQuota(
  quota: QuotaSnapshot | undefined,
  now = Date.now(),
): boolean {
  return (
    !!quota &&
    !quota.stale &&
    quota.updated_at !== null &&
    now - quota.updated_at < 60000 &&
    quota.xai_billing?.allow_access !== false &&
    quota.xai_billing?.subscription_error == null &&
    quota.extra_usage?.monthly_limit === 0 &&
    (quota.xai_billing?.prepaid_balance ?? 0) === 0
  );
}
