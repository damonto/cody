import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../../../src/shared/concurrency";
import type { AccountView } from "../../../../src/providers/oauth/schema";
import type { XaiProviderConfig } from "../../../../src/config/types";
import { Empty, ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  accountHealthOptions,
  accountsOptions,
  quotaQueryKey,
  refreshAccountQuota,
} from "@/features/oauth-accounts/api";
import { AccountCard } from "./account-card";
import { useNow } from "../codex/status";

export function XaiAccounts({
  provider,
  pending,
  onAdd,
  onConfigure,
  onMove,
  onRemove,
  onToggle,
}: {
  provider: XaiProviderConfig;
  pending: boolean;
  onAdd: () => void;
  onConfigure: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, disabled: boolean) => void;
}) {
  const cache = useQueryClient();
  const now = useNow();
  const refs = provider.credentials.map(
    (credential) => credential.auth.account_ref,
  );
  const key = quotaQueryKey(["xai", ...refs]);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const accounts = await cache.fetchQuery(accountsOptions("xai"));
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
  const health = useQuery({
    ...accountHealthOptions("xai"),
    enabled: refs.length > 0,
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
  const cooldowns = new Map(
    health.data?.map((entry) => [entry.credential_id, entry]),
  );
  const busy = refresh.isPending || query.isFetching;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            !query.data?.some(
              (account) => account.status === OAuthAccountViewStatus.Ready,
            ) || busy
          }
          onClick={() => refresh.mutate(undefined)}
        >
          <RefreshCw />
          Refresh all quotas
        </Button>
        <Button size="sm" disabled={pending} onClick={onAdd}>
          <Plus />
          Add xAI account
        </Button>
      </div>
      <div className="space-y-4">
        {!!refs.length && query.isPending && <Loading />}
        {query.error && (
          <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        )}
        {health.error && (
          <ErrorNotice
            error={health.error}
            retry={() => void health.refetch()}
          />
        )}
        {refresh.error && <ErrorNotice error={refresh.error} />}
        {!provider.credentials.length ? (
          <Empty title="No xAI accounts">
            Authorize a Xai subscription account to start balancing requests.
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {provider.credentials.map((credential, index) => (
              <AccountCard
                key={credential.id}
                credential={credential}
                index={index}
                count={provider.credentials.length}
                account={accounts.get(credential.auth.account_ref)}
                health={
                  cooldowns.get(credential.id)?.account_ref ===
                  credential.auth.account_ref
                    ? cooldowns.get(credential.id)
                    : undefined
                }
                now={now}
                staleError={query.error?.message}
                pending={pending}
                refreshing={busy}
                onRefresh={() => refresh.mutate(credential.auth.account_ref)}
                onConfigure={() => onConfigure(credential.id)}
                onMove={(direction) => onMove(credential.id, direction)}
                onRemove={() => onRemove(credential.id)}
                onToggle={(enabled) => onToggle(credential.id, !enabled)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
