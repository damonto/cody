import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { read, rpc } from "@/lib/api";
import {
  accountViewSchema,
  sessionViewSchema,
  type AccountView,
} from "../../../../src/providers/oauth/schema";

export const quotaQueryKey = (providerIds: readonly string[]) =>
  ["antigravity-quotas", ...providerIds] as const;

export const accountsOptions = (providerId: string) =>
  queryOptions({
    queryKey: ["provider-accounts", providerId],
    queryFn: async ({ signal }) => {
      const result = await read(
        rpc["provider-accounts"].$get(
          { query: { provider_id: providerId } },
          { init: { signal } },
        ),
      );
      return result.items.map((item) => accountViewSchema.parse(item));
    },
    enabled: /^[A-Za-z0-9._-]{1,256}$/.test(providerId),
  });
export const accountOptions = (ref: string) =>
  queryOptions({
    queryKey: ["provider-account", ref],
    queryFn: async ({ signal }) =>
      accountViewSchema.parse(
        await read(
          rpc["provider-accounts"][":ref"].$get(
            { param: { ref } },
            { init: { signal } },
          ),
        ),
      ),
    enabled: !!ref,
  });
export async function refreshModels(ref: string) {
  return accountViewSchema.parse(
    await read(
      rpc["provider-accounts"][":ref"].models.$post({
        param: { ref },
        json: {},
      }),
    ),
  );
}
export async function refreshQuota(
  ref: string,
  force = false,
  signal?: AbortSignal,
) {
  return accountViewSchema.parse(
    await read(
      rpc["provider-accounts"][":ref"].quota.$post(
        { param: { ref }, json: { force } },
        { init: { signal } },
      ),
    ),
  );
}

export async function refreshAccountQuota(
  account: AccountView,
  force: boolean,
  signal?: AbortSignal,
): Promise<AccountView> {
  signal?.throwIfAborted();
  if (account.status !== "ready") return account;
  try {
    return await refreshQuota(account.account_ref, force, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...account,
      quota: {
        ...account.quota,
        stale: true,
        last_error:
          error instanceof Error ? error.message : "Quota refresh failed",
      },
    };
  }
}

function mergeAccounts(
  previous: AccountView[],
  updates: readonly AccountView[],
) {
  const accounts = new Map(
    previous.map((account) => [account.account_ref, account]),
  );
  for (const account of updates) accounts.set(account.account_ref, account);
  return [...accounts.values()];
}

/** Commit authoritative mutations to every account view, after fencing older reads. */
export async function cacheAccounts(
  cache: QueryClient,
  updates: readonly AccountView[],
): Promise<void> {
  const providers = new Set(updates.map((account) => account.provider_id));
  const quotaQueries = cache.getQueryCache().findAll({
    queryKey: ["antigravity-quotas"],
    predicate: (query) =>
      query.queryKey
        .slice(1)
        .some((id) => typeof id === "string" && providers.has(id)),
  });
  await Promise.all([
    ...updates.map((account) =>
      cache.cancelQueries({
        queryKey: accountOptions(account.account_ref).queryKey,
      }),
    ),
    ...[...providers].map((id) =>
      cache.cancelQueries({ queryKey: accountsOptions(id).queryKey }),
    ),
    ...quotaQueries.map((query) =>
      cache.cancelQueries({ queryKey: query.queryKey, exact: true }),
    ),
  ]);
  for (const account of updates)
    cache.setQueryData(accountOptions(account.account_ref).queryKey, account);
  for (const id of providers) {
    const key = accountsOptions(id).queryKey;
    cache.setQueryData(
      key,
      (previous) =>
        previous &&
        mergeAccounts(
          previous,
          updates.filter((account) => account.provider_id === id),
        ),
    );
    // A previously unloaded list may contain other accounts, so never replace it with a partial inventory.
    void cache.invalidateQueries({ queryKey: key });
  }
  for (const query of quotaQueries) {
    cache.setQueryData<AccountView[]>(
      query.queryKey,
      (previous) =>
        previous &&
        mergeAccounts(
          previous,
          updates.filter((account) =>
            query.queryKey.slice(1).includes(account.provider_id),
          ),
        ),
    );
    void cache.invalidateQueries({ queryKey: query.queryKey, exact: true });
  }
}
export async function disconnectAccount(ref: string) {
  return accountViewSchema.parse(
    await read(
      rpc["provider-accounts"][":ref"].disconnect.$post({
        param: { ref },
        json: {},
      }),
    ),
  );
}
export const sessionOptions = (id: string) =>
  queryOptions({
    queryKey: ["oauth-session", id],
    queryFn: async ({ signal }) =>
      sessionViewSchema.parse(
        await read(
          rpc.oauth.sessions[":id"].$get(
            { param: { id } },
            { init: { signal } },
          ),
        ),
      ),
    enabled: !!id,
    retry: false,
  });
