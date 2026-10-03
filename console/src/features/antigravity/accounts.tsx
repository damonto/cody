import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../../../src/shared/concurrency";
import type { AccountView } from "../../../../src/providers/oauth/schema";
import type { AntigravityProviderConfig } from "../../../../src/config/types";
import { Empty, ErrorNotice } from "@/components/common";
import { AccountCardGrid } from "@/features/oauth-accounts/account-card-grid";
import { AccountCardsSkeleton } from "@/features/oauth-accounts/account-cards-skeleton";
import { Button } from "@/components/ui/button";
import {
  accountsOptions,
  accountHealthOptions,
  quotaQueryKey,
  refreshAccountQuota,
} from "@/features/oauth-accounts/api";
import { AccountCard } from "./account-card";

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
  const health = useQuery(accountHealthOptions(provider.id));
  const refs = provider.credentials.map(
    (credential) => credential.auth.account_ref,
  );
  const key = quotaQueryKey([provider.id, ...refs]);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const previous = new Map(
        cache
          .getQueryData<AccountView[]>(key)
          ?.map((account) => [account.account_ref, account]),
      );
      const accounts = await cache.fetchQuery({
        ...accountsOptions(provider.id),
        staleTime: 0,
      });
      return mapWithConcurrency(
        accounts.filter((account) => refs.includes(account.account_ref)),
        PROVIDER_FAN_OUT_CONCURRENCY,
        async (account) => {
          const cached = previous.get(account.account_ref);
          // Project polling refreshes status; unchanged ready accounts keep
          // on-demand quotas. A newly ready credential gets its first snapshot.
          return cached?.status === OAuthAccountViewStatus.Ready &&
            account.status === OAuthAccountViewStatus.Ready &&
            cached.generation === account.generation
            ? account
            : refreshAccountQuota(account, false, signal);
        },
      );
    },
    enabled: refs.length > 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some(
        (account) => account.project_initialization?.status === "pending",
      )
        ? 5000
        : false,
  });
  const refresh = useMutation({
    mutationFn: (ref?: string) =>
      mapWithConcurrency(
        (query.data ?? []).filter(
          (account) =>
            account.status === OAuthAccountViewStatus.Ready &&
            (!ref || account.account_ref === ref),
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
                  stale:
                    account.status !== OAuthAccountViewStatus.Ready ||
                    quota.stale,
                },
              }
            : account;
        }),
      );
      void health.refetch();
    },
  });
  const accounts = new Map(
    query.data?.map((account) => [account.account_ref, account]),
  );
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            !query.data?.some(
              (account) => account.status === OAuthAccountViewStatus.Ready,
            ) ||
            refresh.isPending ||
            query.isFetching
          }
          onClick={() => refresh.mutate(undefined)}
        >
          <RefreshCw />
          Refresh all
        </Button>
        <Button size="sm" disabled={pending} onClick={onAdd}>
          <Plus />
          Add Google account
        </Button>
      </div>
      <div className="space-y-4">
        {query.error && (
          <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        )}
        {health.error && (
          <ErrorNotice
            error={health.error}
            retry={() => void health.refetch()}
          />
        )}
        {!provider.credentials.length ? (
          <Empty title="No Google accounts">
            Authorize a Google account with Antigravity access to start
            balancing requests.
          </Empty>
        ) : (
          <AccountCardGrid>
            {query.isPending ? (
              <AccountCardsSkeleton credentials={provider.credentials} />
            ) : (
              provider.credentials.map((credential, index) => (
                <AccountCard
                  key={credential.id}
                  credential={credential}
                  index={index}
                  count={provider.credentials.length}
                  account={accounts.get(credential.auth.account_ref)}
                  health={health.data?.find(
                    (entry) =>
                      entry.credential_id === credential.id &&
                      entry.account_ref === credential.auth.account_ref,
                  )}
                  staleError={query.error?.message}
                  pending={pending}
                  refreshing={refresh.isPending || query.isFetching}
                  onRefresh={() => refresh.mutate(credential.auth.account_ref)}
                  onConfigure={() => onConfigure(credential.id)}
                  onMove={(direction) => onMove(credential.id, direction)}
                  onRemove={() => onRemove(credential.id)}
                />
              ))
            )}
          </AccountCardGrid>
        )}
      </div>
    </section>
  );
}
