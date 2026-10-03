import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { CodexProviderConfig } from "../../../../src/config/types";
import type {
  AccountHealth,
  AccountView,
} from "../../../../src/providers/oauth/schema";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { AccountCardFooter } from "@/features/oauth-accounts/account-card-footer";
import { daysUntil, expiryTone, planLabel, relative, toneText } from "./plan";
import { QuotaWindow } from "./quota-window";
import { ResetCreditsDialog } from "./reset-credits";
import { healthBadge, usableCredits, type HealthBadge } from "./status";

type Credential = CodexProviderConfig["credentials"][number];

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
  const [resetting, setResetting] = useState(false);
  const title = account?.email ?? `ChatGPT account ${index + 1}`;
  const badge = healthBadge(credential, account, health, now);
  const quota = account?.quota;
  const plan =
    quota?.subscription?.tier_id ?? account?.codex?.plan_type ?? null;
  const days = daysUntil(
    quota?.subscription?.active_until ??
      account?.codex?.subscription_active_until,
    now,
  );
  const resets = quota?.reset_credits
    ? usableCredits(quota.reset_credits.credits, now).length ||
      quota.reset_credits.available_count
    : null;
  const credits = quota?.credits_balance;
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
            <Badge variant="secondary">{planLabel(plan)}</Badge>
            {days !== null && (
              <span className={toneText[expiryTone(days)]}>
                {days > 0 ? `${days}d left` : "Expired"}
              </span>
            )}
            {resets !== null && (
              <Badge
                variant="outline"
                className="gap-1 font-normal"
                title="Available rate-limit resets"
              >
                <RotateCcw />
                {resets} reset{resets === 1 ? "" : "s"}
              </Badge>
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
        {quota && !quota.groups.length && (
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
            {group.buckets.map((bucket) => (
              <QuotaWindow
                key={bucket.id}
                group={group.label}
                bucket={bucket}
                now={now}
              />
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {credits &&
            (credits.unlimited ? (
              <span>Credits: unlimited</span>
            ) : credits.has_credits ? (
              <span>Credits: {credits.balance ?? "available"}</span>
            ) : null)}
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
            {staleError ?? quota?.last_error} · Last successful data is
            retained.
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
      >
        <Button
          size="sm"
          variant="outline"
          disabled={account?.status !== OAuthAccountViewStatus.Ready}
          onClick={() => setResetting(true)}
        >
          <RotateCcw />
          Reset{resets ? ` (${resets})` : ""}
        </Button>
      </AccountCardFooter>
      {account && (
        <ResetCreditsDialog
          key={account.account_ref}
          account={account}
          label={title}
          now={now}
          open={resetting}
          onOpenChange={setResetting}
        />
      )}
    </Card>
  );
}
