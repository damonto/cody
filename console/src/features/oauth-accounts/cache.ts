import type { QueryClient } from "@tanstack/react-query";
import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";
import type { AccountView } from "../../../../src/providers/oauth/schema";

const QUOTAS = "provider-quotas";
export const accountQueryKey = (ref: string) =>
  ["provider-account", ref] as const;
export const accountsQueryKey = (providerId: string) =>
  ["provider-accounts", providerId] as const;
/** Quota views scoped to a provider and its current account references. */
export const quotaQueryKey = (providerIds: readonly string[]) =>
  [QUOTAS, ...providerIds] as const;

function mergeAccount(
  previous: AccountView | undefined,
  update: AccountView,
): AccountView {
  if (!previous || previous.generation === undefined) return update;
  if (update.generation === undefined) return previous;
  if (previous.generation > update.generation) return previous;
  // Successful replacement credentials always advance generation; a stale ready
  // view must not undo a terminal refresh failure in the same generation.
  if (
    previous.generation === update.generation &&
    previous.status !== OAuthAccountViewStatus.Ready &&
    update.status === OAuthAccountViewStatus.Ready
  )
    return previous;
  return update;
}
function mergeAccounts(
  previous: AccountView[],
  updates: readonly AccountView[],
): AccountView[] {
  const accounts = new Map(
    previous.map((account) => [account.account_ref, account]),
  );
  for (const update of updates)
    accounts.set(
      update.account_ref,
      mergeAccount(accounts.get(update.account_ref), update),
    );
  return [...accounts.values()];
}

/** Fence at the synchronous cache write, after all asynchronous reader cancellation. */
export async function cacheAccounts(
  cache: QueryClient,
  updates: readonly AccountView[],
): Promise<void> {
  if (!updates.length) return;
  const providers = new Set(updates.map((account) => account.provider_id));
  const quotaQueries = cache.getQueryCache().findAll({
    queryKey: [QUOTAS],
    predicate: (query) =>
      query.queryKey
        .slice(1)
        .some((id) => typeof id === "string" && providers.has(id)),
  });
  // A cancelled fetch must not restore a snapshot predating a newer mutation.
  const cancel = (queryKey: readonly unknown[]) =>
    cache.cancelQueries({ queryKey, exact: true }, { revert: false });
  await Promise.all([
    ...updates.map((account) => cancel(accountQueryKey(account.account_ref))),
    ...[...providers].map((id) => cancel(accountsQueryKey(id))),
    ...quotaQueries.map((query) => cancel(query.queryKey)),
  ]);
  const latest = new Map(
    updates.map((account) => [account.account_ref, account]),
  );
  const retainNewer = (account: AccountView) => {
    const update = latest.get(account.account_ref);
    if (update) latest.set(account.account_ref, mergeAccount(account, update));
  };
  for (const id of providers)
    cache
      .getQueryData<AccountView[]>(accountsQueryKey(id))
      ?.forEach(retainNewer);
  for (const query of quotaQueries)
    cache.getQueryData<AccountView[]>(query.queryKey)?.forEach(retainNewer);
  const committed = [...latest.values()]
    .map((account) =>
      cache.setQueryData<AccountView>(
        accountQueryKey(account.account_ref),
        (previous) => mergeAccount(previous, account),
      ),
    )
    .filter((account) => account !== undefined);
  for (const id of providers) {
    const key = accountsQueryKey(id);
    cache.setQueryData<AccountView[]>(
      key,
      (previous) =>
        previous &&
        mergeAccounts(
          previous,
          committed.filter((account) => account.provider_id === id),
        ),
    );
    // A previously unloaded list may contain other accounts; never create a partial list.
    void cache.invalidateQueries({ queryKey: key });
  }
  for (const query of quotaQueries) {
    cache.setQueryData<AccountView[]>(
      query.queryKey,
      (previous) =>
        previous &&
        mergeAccounts(
          previous,
          committed.filter((account) =>
            query.queryKey.slice(1).includes(account.provider_id),
          ),
        ),
    );
    void cache.invalidateQueries({ queryKey: query.queryKey, exact: true });
  }
}
