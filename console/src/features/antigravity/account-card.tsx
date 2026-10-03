import type { AntigravityProviderConfig } from "../../../../src/config/types";
import type {
  AccountHealth,
  AccountView,
} from "../../../../src/providers/oauth/schema";
import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values";
import { Status } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AccountCardFooter } from "@/features/oauth-accounts/account-card-footer";
import { cn } from "@/lib/utils";
import { AccountQuota } from "./quota";
import { ProjectInitialization } from "./project-initialization";
import { AccountError } from "./account-error";

export function AccountCard({
  credential,
  index,
  count,
  account,
  health,
  staleError,
  pending,
  refreshing,
  onRefresh,
  onConfigure,
  onMove,
  onRemove,
}: {
  credential: AntigravityProviderConfig["credentials"][number];
  index: number;
  count: number;
  account: AccountView | undefined;
  health: AccountHealth | undefined;
  staleError: string | undefined;
  pending: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onConfigure: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const title = account?.email ?? `Google account ${index + 1}`;
  return (
    <Card
      className={cn("gap-4 shadow-none", credential.disabled && "opacity-70")}
      data-account-id={credential.id}
    >
      <CardHeader className="gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="truncate text-sm font-medium" title={title}>
            {title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Status value={account?.status ?? "unknown"} />
            {credential.disabled && <Badge variant="outline">Disabled</Badge>}
            <span>Priority {credential.priority}</span>
            {health && !health.available && (
              <Badge variant="outline">Account cooling down</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-3 break-words">
        {health?.model_cooldowns?.map((block) => (
          <p key={block.model} className="text-xs text-muted-foreground">
            {block.model}:{" "}
            {block.reason === "quota"
              ? "Quota / rate limit"
              : "Quota status unavailable"}
            {block.until !== null &&
              ` until ${new Date(block.until).toLocaleString()}`}
          </p>
        ))}
        {account?.error && (
          <p role="alert" className="text-xs text-destructive">
            {account.error}
          </p>
        )}
        {account && <ProjectInitialization account={account} />}
        <AccountError
          error={account?.models_error}
          verification={account?.models_verification}
        />
        {account && (
          <AccountQuota quota={account.quota} staleError={staleError} />
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
