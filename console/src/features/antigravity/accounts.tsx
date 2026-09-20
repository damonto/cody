import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../../../src/shared/concurrency";
import type { AccountView } from "../../../../src/providers/oauth/schema";
import type { AntigravityProviderConfig } from "../../../../src/config/types";
import { ErrorNotice, Loading, Status } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { accountsOptions, quotaQueryKey, refreshAccountQuota } from "./api";
import { AccountQuota } from "./quota";

export function AntigravityAccounts({
  provider,
  pending,
  onAdd,
  onConfigure,
  onMove,
  onRemove,
}: {
  provider: AntigravityProviderConfig;
  pending: boolean;
  onAdd: () => void;
  onConfigure: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
}) {
  const cache = useQueryClient();
  const refs = provider.credentials.map(
    (credential) => credential.auth.account_ref,
  );
  const key = quotaQueryKey(["antigravity", ...refs]);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const accounts = await cache.fetchQuery(accountsOptions("antigravity"));
      return mapWithConcurrency(
        accounts.filter((account) => refs.includes(account.account_ref)),
        PROVIDER_FAN_OUT_CONCURRENCY,
        (account) => refreshAccountQuota(account, false, signal),
      );
    },
    enabled: refs.length > 0,
    refetchInterval: 300_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: (ref?: string) =>
      mapWithConcurrency(
        (query.data ?? []).filter(
          (account) =>
            account.status === "ready" && (!ref || account.account_ref === ref),
        ),
        PROVIDER_FAN_OUT_CONCURRENCY,
        (account) => refreshAccountQuota(account, true),
      ),
    onSuccess: (accounts) => {
      const updates = new Map(
        accounts.map((account) => [account.account_ref, account.quota]),
      );
      cache.setQueryData<AccountView[]>(key, (previous) =>
        previous?.map((account) => {
          const quota = updates.get(account.account_ref);
          // A slow batch must not restore authorization state changed by a concurrent account operation.
          return quota
            ? {
                ...account,
                quota: {
                  ...quota,
                  stale: account.status !== "ready" || quota.stale,
                },
              }
            : account;
        }),
      );
    },
  });
  const accounts = new Map(
    query.data?.map((account) => [account.account_ref, account]),
  );
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">Google accounts</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              !query.data?.some((account) => account.status === "ready") ||
              refresh.isPending ||
              query.isFetching
            }
            onClick={() => refresh.mutate(undefined)}
          >
            <RefreshCw />
            Refresh all quotas
          </Button>
          <Button size="sm" disabled={pending} onClick={onAdd}>
            <Plus />
            Add Google account
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!!refs.length && query.isPending && <Loading />}
        {query.error && (
          <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        )}
        {!provider.credentials.length && (
          <p className="text-sm text-muted-foreground">
            No authorized accounts yet.
          </p>
        )}
        {provider.credentials.map((credential, index) => {
          const account = accounts.get(credential.auth.account_ref);
          const label = account?.email ?? `Google account ${index + 1}`;
          return (
            <div
              className="space-y-3 rounded-lg border p-4"
              key={credential.id}
              data-account-id={credential.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Status value={account?.status ?? "unknown"} />
                    {credential.disabled && (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                    <span>Priority {credential.priority}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      account?.status !== "ready" ||
                      refresh.isPending ||
                      query.isFetching
                    }
                    onClick={() => refresh.mutate(credential.auth.account_ref)}
                  >
                    Refresh quota
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onConfigure(credential.id)}
                  >
                    Manage
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pending}
                        aria-label={`Account actions for ${label}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={index === 0}
                        onSelect={() => onMove(credential.id, -1)}
                      >
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === provider.credentials.length - 1}
                        onSelect={() => onMove(credential.id, 1)}
                      >
                        Move down
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => onRemove(credential.id)}
                      >
                        Remove from draft
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {account?.error && (
                <p role="alert" className="text-xs text-destructive">
                  {account.error}
                </p>
              )}
              {account && (
                <AccountQuota
                  account={
                    query.error
                      ? {
                          ...account,
                          quota: {
                            ...account.quota,
                            stale: true,
                            last_error: query.error.message,
                          },
                        }
                      : account
                  }
                />
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
