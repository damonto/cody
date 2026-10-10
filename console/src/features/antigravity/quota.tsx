import { quotaModelGroups } from "./presentation";
import type { QuotaSnapshot } from "../../../../src/providers/oauth/schema";
import { date } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { QuotaProgress } from "@/features/oauth-accounts/quota-progress";
import { AccountError } from "./account-error";

function resetTime(value: string | null): string {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp)
    ? `Resets ${date(timestamp)}`
    : "Reset time unknown";
}
export function AccountQuota({
  quota,
  staleError,
}: {
  quota: QuotaSnapshot;
  staleError?: string;
}) {
  return (
    <div className="space-y-3 text-xs" aria-label="Account quota">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {quota.subscription?.tier_name ??
            quota.subscription?.tier_id ??
            "Unknown plan"}
        </Badge>
        {(quota.stale || staleError) && <Badge variant="outline">Stale</Badge>}
        <span className="text-muted-foreground">
          Updated {quota.updated_at === null ? "never" : date(quota.updated_at)}
        </span>
      </div>
      {staleError && staleError !== quota.last_error && (
        <AccountError error={staleError} />
      )}
      <AccountError
        error={quota.last_error}
        verification={quota.verification}
      />
      {!quota.groups.length && (
        <p className="text-muted-foreground">
          Quota unknown. Refresh after authorization is ready.
        </p>
      )}
      <div className="space-y-3">
        {quotaModelGroups(quota.groups).map((group) => (
          <div key={group.id} className="space-y-2">
            <p className="font-medium">{group.label}</p>
            {!group.buckets.length && <p>Unknown</p>}
            {group.buckets.map((bucket) => (
              <div key={bucket.id} className="space-y-1.5">
                <QuotaProgress
                  label={`${bucket.label} · ${bucket.window ?? "Unknown window"}`}
                  remainingFraction={bucket.remaining_fraction}
                  ariaLabel={`${group.label} ${bucket.label} remaining`}
                />
                <p className="text-[11px] text-muted-foreground">
                  {resetTime(bucket.reset_at)}
                </p>
              </div>
            ))}
          </div>
        ))}
      </div>
      {!!quota.subscription?.credits.length && (
        <div className="space-y-1">
          {quota.subscription.credits.map((credit, index) => (
            <p key={`${credit.type}-${index}`}>
              {credit.type === "GOOGLE_ONE_AI"
                ? "Google One AI credits"
                : (credit.type ?? "AI credits")}
              : {credit.amount ?? "Unavailable"}
            </p>
          ))}
          <p className="text-muted-foreground">Credit spending is disabled.</p>
        </div>
      )}
    </div>
  );
}
