import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";
import { canUseXaiUnreportedQuota } from "../../../../src/shared/xai-quota";

import type { XaiProviderConfig } from "../../../../src/config/types";
import type {
  AccountHealth,
  AccountView,
} from "../../../../src/providers/oauth/schema";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { AccountCardFooter } from "@/features/oauth-accounts/account-card-footer";
import { daysUntil, expiryTone, relative, toneText } from "../codex/plan";
import { QuotaWindow } from "../codex/quota-window";

import { healthBadge, type HealthBadge } from "../codex/status";

type Credential = XaiProviderConfig["credentials"][number];

const badgeTone: Readonly<Record<HealthBadge["tone"], string>> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  bad: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  muted: "text-muted-foreground",
};

export function AccountCard({
  credential,
  index,
  count,
  account,
  health,
  now,
  staleError,
  pending,
  refreshing,
  onRefresh,
  onConfigure,
  onMove,
  onRemove,
  onToggle,
}: {
  credential: Credential;
  index: number;
  count: number;
  account: AccountView | undefined;
  health: AccountHealth | undefined;
  now: number;
  staleError: string | undefined;
  pending: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onConfigure: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const title = account?.email ?? `xAI account ${index + 1}`;
  const baseBadge = healthBadge(credential, account, health, now);
  const quota = account?.quota;
  const unreportedQuota = canUseXaiUnreportedQuota(quota, now);
  const quotaUnknown =
    !unreportedQuota &&
    (!quota ||
      quota.stale ||
      !quota.groups.length ||
      quota.groups.some(
        (group) =>
          !group.buckets.length ||
          group.buckets.some((bucket) => bucket.used_percent == null),
      ));
  const badge =
    baseBadge.tone === "ok" && quota?.xai_billing?.allow_access === false
      ? { text: "Access restricted", tone: "warn" as const }
      : baseBadge.tone === "ok" && quotaUnknown
        ? {
            text: "Quota unknown",
            tone: "muted" as const,
            title: "Subscription quota must be known before routing",
          }
        : baseBadge;
  const plan =
    quota?.subscription?.tier_name ?? quota?.subscription?.tier_id ?? null;
  const days = daysUntil(quota?.subscription?.active_until ?? null, now);
  const credits = quota?.extra_usage;
  const multipleGroups = (quota?.groups.length ?? 0) > 1;
  return (
    <Card
      className={cn("gap-4 shadow-none", credential.disabled && "opacity-70")}
      data-account-id={credential.id}
    >
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="truncate text-sm font-medium" title={title}>
            {title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="secondary">
              {plan
                ? plan.replace(/^xai_/, "").replaceAll("_", " ")
                : "Unknown plan"}
            </Badge>
            {days !== null && (
              <span className={toneText[expiryTone(days)]}>
                {days > 0 ? `${days}d left` : "Expired"}
              </span>
            )}
            <span>Priority {credential.priority}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge
            variant="outline"
            className={cn("font-normal", badgeTone[badge.tone])}
            title={badge.title}
          >
            {badge.text}
          </Badge>
          <Switch
            checked={!credential.disabled}
            disabled={pending}
            aria-label={`${credential.disabled ? "Enable" : "Disable"} ${title}`}
            onCheckedChange={onToggle}
          />
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        {account?.error && (
          <p role="alert" className="text-xs text-destructive">
            {account.error}
          </p>
        )}
        {health?.quota_blocks?.map((block, index) => (
          <p
            key={`${block.model}-${index}`}
            className="text-xs text-destructive"
          >
            {block.model ?? "All models"}: quota exhausted
            {block.until ? ` · back ${relative(block.until, now)}` : ""}
          </p>
        ))}
        {unreportedQuota &&
          (!quota?.groups.length ||
            quota.groups.some((group) =>
              group.buckets.some((bucket) => bucket.used_percent == null),
            )) && (
            <p className="text-xs text-muted-foreground">
              Remaining quota is not reported. Limits are enforced by xAI.
            </p>
          )}
        {!unreportedQuota && quota && !quota.groups.length && (
          <p className="text-xs text-muted-foreground">
            Quota unknown. Refresh after authorization is ready.
          </p>
        )}
        {quota?.groups.map((group) => (
          <div key={group.id} className="space-y-2">
            {multipleGroups && (
              <p className="text-xs font-medium">
                {group.label}
                {group.limit_reached && (
                  <span className="ml-2 text-destructive">Limit reached</span>
                )}
              </p>
            )}
            {group.buckets
              .filter(
                (bucket) => !unreportedQuota || bucket.used_percent != null,
              )
              .map((bucket) => (
                <QuotaWindow
                  key={bucket.id}
                  group={group.label}
                  bucket={bucket}
                  now={now}
                />
              ))}
          </div>
        ))}
        {quota?.xai_billing?.products.map((product, index) => (
          <p
            key={`${product.product}-${index}`}
            className="text-xs text-muted-foreground"
          >
            {product.product}:{" "}
            {product.used_percent === null
              ? "Unknown"
              : `${product.used_percent}% used`}
          </p>
        ))}
        {quota?.xai_billing?.monthly_limit != null && (
          <p className="text-xs text-muted-foreground">
            Monthly included usage:{" "}
            {quota.xai_billing.included_used === null
              ? "Unknown"
              : `$${(quota.xai_billing.included_used / 100).toFixed(2)}`}{" "}
            / ${(quota.xai_billing.monthly_limit / 100).toFixed(2)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {credits && (
            <span>
              Extra Usage: {credits.is_enabled ? "Enabled" : "Disabled"} · Used{" "}
              {credits.used_credits === null
                ? "unknown"
                : new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: credits.currency ?? "USD",
                  }).format(credits.used_credits / 100)}{" "}
              /{" "}
              {credits.monthly_limit === null
                ? "Unlimited"
                : new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: credits.currency ?? "USD",
                  }).format(credits.monthly_limit / 100)}
              {credits.disabled_reason &&
                ` · ${credits.disabled_reason.replaceAll("_", " ")}`}
            </span>
          )}
          {(quota?.stale || staleError) && (
            <Badge variant="outline">Stale</Badge>
          )}
          {quota && (
            <span>
              Updated{" "}
              {quota.updated_at === null
                ? "never"
                : relative(quota.updated_at, now)}
            </span>
          )}
        </div>
        {(staleError ?? quota?.last_error) && (
          <p role="alert" className="text-xs text-destructive">
            {staleError ?? quota?.last_error} ·{" "}
            {quota?.updated_at != null
              ? "Last successful data is retained."
              : "No quota data has been fetched yet."}
          </p>
        )}
        {quota?.xai_billing?.subscription_error && (
          <p role="alert" className="text-xs text-destructive">
            Subscription quota: {quota.xai_billing.subscription_error}
          </p>
        )}
        {quota?.xai_billing?.monthly_error && (
          <p role="alert" className="text-xs text-destructive">
            Monthly billing: {quota.xai_billing.monthly_error}
          </p>
        )}
        {quota?.xai_billing?.settings_error && (
          <p role="alert" className="text-xs text-destructive">
            Account settings: {quota.xai_billing.settings_error}
          </p>
        )}
      </CardContent>
      <AccountCardFooter
        title={title}
        index={index}
        count={count}
        pending={pending}
        refreshDisabled={
          account?.status !== OAuthAccountViewStatus.Ready || refreshing
        }
        onRefresh={onRefresh}
        onConfigure={onConfigure}
        onMove={onMove}
        onRemove={onRemove}
      />
    </Card>
  );
}
