import { ProviderType } from "../../config/values.ts";

import { type AccountView } from "./schema.ts";

import {
  accountViewStatus,
  quotaIsStale,
  type AccountSnapshot,
  type ReadonlyData,
} from "./state.ts";
export function accountView(
  account: AccountSnapshot,
): ReadonlyData<AccountView> {
  return {
    generation: account.generation,
    revision: account.revision,
    ...(account.provider_type === ProviderType.Codex
      ? { siwc_revocation_error: account.siwc_revocation_error }
      : {}),
    ...(account.provider_type === ProviderType.Codex
      ? {
          siwc: account.siwc
            ? {
                generation: account.siwc_generation,
                status: account.siwc.status,
                email: account.siwc.identity?.email ?? null,
                expires_at: account.siwc.tokens?.expires_at ?? null,
                plan_usage_enabled:
                  account.siwc.codex?.plan_usage_enabled ?? false,
                error: account.siwc.error,
                models: account.siwc.models,
                models_updated_at: account.siwc.models_updated_at,
                models_error: account.siwc.models_error,
                quota: {
                  ...account.siwc.quota,
                  stale: quotaIsStale(account.siwc),
                },
              }
            : null,
        }
      : {}),
    account_ref: account.account_ref,
    provider_id: account.provider_id,
    status: accountViewStatus(account),
    email: account.identity?.email ?? null,
    codex: account.codex,
    claude: account.claude,
    expires_at: account.tokens?.expires_at ?? null,
    error: account.error,
    models: account.models,
    models_updated_at: account.models_updated_at,
    models_error: account.models_error,
    quota: {
      ...account.quota,
      stale: quotaIsStale(account),
    },
  };
}
