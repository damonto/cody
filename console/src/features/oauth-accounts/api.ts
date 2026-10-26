import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";

import { queryOptions } from "@tanstack/react-query";
import { read, rpc } from "@/lib/api";
import {
  accountHealthSchema,
  accountViewSchema,
  consumeResetReplySchema,
  sessionViewSchema,
  type AccountView,
} from "../../../../src/providers/oauth/schema";

import { accountQueryKey, accountsQueryKey } from "./cache";
export { cacheAccounts, quotaQueryKey } from "./cache";

export const accountsOptions = (providerId: string) =>
  queryOptions({
    queryKey: accountsQueryKey(providerId),
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
    queryKey: accountQueryKey(ref),
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
    refetchInterval: (query) =>
      query.state.data?.project_initialization?.status === "pending"
        ? 5000
        : false,
  });
export async function retryProjectInitialization(ref: string) {
  return accountViewSchema.parse(
    await read(
      rpc["provider-accounts"][":ref"]["retry-project"].$post({
        param: { ref },
        json: {},
      }),
    ),
  );
}
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
  if (account.status !== OAuthAccountViewStatus.Ready) return account;
  if (
    account.codex?.mode === "siwc" &&
    (!force || !account.codex.plan_usage_enabled)
  )
    return account;
  try {
    return account.codex?.mode === "siwc"
      ? await refreshModels(account.account_ref)
      : await refreshQuota(account.account_ref, force, signal);
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

/** Current inference cooldowns of each account, keyed by credential ID. */
export const accountHealthOptions = (providerId: string) =>
  queryOptions({
    queryKey: ["provider-account-health", providerId],
    queryFn: async ({ signal }) => {
      const result = await read(
        rpc["provider-accounts"].health.$get(
          { query: { provider_id: providerId } },
          { init: { signal } },
        ),
      );
      return result.items.map((item) => accountHealthSchema.parse(item));
    },
  });
export async function refreshResetCredits(ref: string) {
  return accountViewSchema.parse(
    await read(
      rpc["provider-accounts"][":ref"]["reset-credits"].$get({
        param: { ref },
      }),
    ),
  );
}
export async function consumeResetCredit(
  ref: string,
  redeemRequestId: string,
  creditId?: string,
) {
  return consumeResetReplySchema.parse(
    await read(
      rpc["provider-accounts"][":ref"]["reset-credits"].consume.$post({
        param: { ref },
        json: {
          redeem_request_id: redeemRequestId,
          ...(creditId ? { credit_id: creditId } : {}),
        },
      }),
    ),
  );
}
