import type { AccountView } from "../../../../src/providers/oauth/schema";
import { date } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

function resetTime(value: string | null): string {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? date(timestamp) : "Unknown";
}
export function AccountQuota({ account }: { account: AccountView }) {
  const quota = account.quota;
  return (
    <div className="space-y-3 text-xs" aria-label="Account quota">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Plan:{" "}
          {quota.subscription?.tier_name ??
            quota.subscription?.tier_id ??
            "Unknown"}
        </span>
        {quota.stale && <Badge variant="outline">Stale</Badge>}
        <span className="text-muted-foreground">
          Updated:{" "}
          {quota.updated_at === null ? "Never" : date(quota.updated_at)}
        </span>
      </div>
      {quota.last_error && (
        <p role="alert" className="text-destructive">
          {quota.last_error} · Last successful data is retained.
        </p>
      )}
      {!quota.groups.length && (
        <p className="text-muted-foreground">
          Quota unknown. Refresh after authorization is ready.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {quota.groups.map((group) => (
          <div key={group.id} className="space-y-2 rounded-md border p-3">
            <p className="font-medium">{group.label}</p>
            {!group.buckets.length && <p>Unknown</p>}
            {group.buckets.map((bucket) => (
              <div key={bucket.id} className="space-y-1.5">
                <div className="flex justify-between gap-3">
                  <span>
                    {bucket.label}
                    {` · ${bucket.window ?? "Unknown window"}`}
                  </span>
                  <span>
                    {bucket.remaining_fraction === null
                      ? "Unknown"
                      : `${Math.round(bucket.remaining_fraction * 100)}% remaining`}
                  </span>
                </div>
                {bucket.remaining_fraction !== null && (
                  <Progress
                    value={bucket.remaining_fraction * 100}
                    aria-label={`${group.label} ${bucket.label} remaining`}
                  />
                )}
                <p className="text-muted-foreground">
                  Resets: {resetTime(bucket.reset_at)}
                </p>
              </div>
            ))}
          </div>
        ))}
      </div>
      {quota.subscription?.credits.length ? (
        <p>
          Available credits:{" "}
          {quota.subscription.credits
            .map(
              (credit) =>
                `${credit.type ?? "Unknown"}: ${credit.amount ?? "Unknown"}`,
            )
            .join(" · ")}
          . Display only; paid credits are not enabled by this gateway.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Available credits: Unknown. Paid credits are not enabled by this
          gateway.
        </p>
      )}
    </div>
  );
}
