import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OAuthProviderConfig } from "../../../../src/config/types";
import type { AccountView } from "../../../../src/providers/oauth/schema";
import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../../../src/shared/concurrency";
import { accountsOptions, cacheAccounts, refreshModels } from "./api";

/** Shared discovery lifecycle scoped to the provider's saved account references. */
export function useModelDiscovery({
  id,
  credentials,
  models: savedModels,
}: Pick<OAuthProviderConfig, "id" | "credentials" | "models">) {
  const cache = useQueryClient();
  const selectAccounts = useCallback(
    (accounts: AccountView[]) => {
      const refs = new Set(
        credentials.map((credential) => credential.auth.account_ref),
      );
      return accounts.filter((account) => refs.has(account.account_ref));
    },
    [credentials],
  );
  const accounts = useQuery({
    ...accountsOptions(id),
    // Keep the full cached inventory available to the authorization picker.
    select: selectAccounts,
  });
  const ready =
    accounts.data?.filter(
      (account) =>
        account.status === OAuthAccountViewStatus.Ready ||
        (account.siwc?.status === OAuthAccountViewStatus.Ready &&
          account.siwc.plan_usage_enabled),
    ) ?? [];
  const discover = useMutation({
    mutationFn: () =>
      mapWithConcurrency(
        ready,
        PROVIDER_FAN_OUT_CONCURRENCY,
        async (account) => {
          let current = account;
          if (account.status === OAuthAccountViewStatus.Ready)
            current = await refreshModels(account.account_ref);
          if (
            current.siwc?.status === OAuthAccountViewStatus.Ready &&
            current.siwc.plan_usage_enabled
          )
            current = await refreshModels(account.account_ref, "siwc");
          return current;
        },
      ),
    onSuccess: (values) => cacheAccounts(cache, values),
  });
  const models = new Map(savedModels.map((id) => [id, id]));
  for (const account of accounts.data ?? []) {
    for (const model of [...account.models, ...(account.siwc?.models ?? [])])
      models.set(model.id, model.display_name);
  }
  return { accounts, discover, models, canDiscover: ready.length > 0 };
}
