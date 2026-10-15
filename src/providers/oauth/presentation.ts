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
  const project = account.antigravity_initialization;
  const projectView: ReadonlyData<AccountView["project_initialization"]> =
    project
      ? {
          status: project.error === null ? "pending" : "error",
          next_retry_at: project.error === null ? project.next_at : null,
          error: project.error,
          verification: project.verification,
        }
      : null;
  return {
    generation: account.generation,
    account_ref: account.account_ref,
    provider_id: account.provider_id,
    status: accountViewStatus(account),
    email: account.identity?.email ?? project?.identity.email ?? null,
    project_id: account.project_id,
    ...(account.provider_type === ProviderType.Antigravity
      ? { project_initialization: projectView }
      : {}),
    codex: account.codex,
    claude: account.claude,
    xai: account.xai,
    expires_at: account.tokens?.expires_at ?? null,
    error: account.error,
    models: account.models,
    models_updated_at: account.models_updated_at,
    models_error: account.models_error,
    models_verification: account.models_verification,
    quota: {
      ...account.quota,
      stale: quotaIsStale(account),
    },
  };
}
