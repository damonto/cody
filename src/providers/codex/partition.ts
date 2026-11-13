import { ProviderType } from "../../config/values.ts";
import { OAuthAccountStatus } from "../oauth/values.ts";
import { OAuthError } from "../oauth/schema.ts";
import {
  freezeAccount,
  emptyQuota,
  type AccountSnapshot,
  type Stored,
} from "../oauth/state.ts";
import type {
  AccountState,
  AccountSnapshotFor,
  StoredFor,
} from "../oauth/provider.ts";
import { codexQuotaSyncSchema } from "./quota.ts";
import type { CodexMode } from "./account-schema.ts";

type CodexStored = StoredFor<typeof ProviderType.Codex>;

function emptySiwcPartition(): NonNullable<CodexStored["siwc"]> {
  return {
    status: OAuthAccountStatus.Disconnected,
    tokens: null,
    identity: null,
    codex: null,
    error: null,
    models: [],
    models_updated_at: null,
    models_error: null,
    quota: emptyQuota(),
    codex_quota_sync: codexQuotaSyncSchema.parse({}),
  };
}

function projectSiwc<
  Account extends CodexStored | AccountSnapshotFor<typeof ProviderType.Codex>,
>(account: Account) {
  return {
    ...account,
    ...(account.siwc ?? emptySiwcPartition()),
    generation: account.siwc_generation,
  };
}

/** The native partition retains its established storage layout. SIWC owns a separate encrypted partition. */
export function codexPartition(
  account: AccountSnapshotFor<typeof ProviderType.Codex>,
  mode: CodexMode,
): AccountSnapshotFor<typeof ProviderType.Codex> {
  if (mode === "native") return account;
  return projectSiwc(account);
}

export function accountPartition(
  account: AccountSnapshot,
  mode: CodexMode = "native",
): AccountSnapshot {
  if (account.provider_type !== ProviderType.Codex) return account;
  return codexPartition(account, mode);
}

export function credentialGeneration(
  account: Stored,
  mode: CodexMode = "native",
): number {
  if (account.provider_type === ProviderType.Codex && mode === "siwc")
    return account.siwc_generation;
  return account.generation;
}

async function editSiwc(
  account: CodexStored,
  update: (account: CodexStored) => void | Promise<void>,
): Promise<void> {
  const partition: CodexStored = projectSiwc(account);
  await update(partition);
  account.siwc_generation = partition.generation;
  account.authorization_generation = partition.authorization_generation;
  account.session = partition.session;
  if (!account.siwc && !partition.codex && !partition.tokens) return;
  if (partition.tokens) account.siwc_revocation_error = null;
  account.siwc = {
    status: partition.status,
    tokens: partition.tokens,
    identity: partition.identity,
    codex: partition.codex,
    error: partition.error,
    models: partition.models,
    models_updated_at: partition.models_updated_at,
    models_error: partition.models_error,
    quota: partition.quota,
    codex_quota_sync: partition.codex_quota_sync,
  };
}

/** Provider policy sees only its partition; all writes still cross the account's durable fence. */
export function siwcState(
  state: AccountState<typeof ProviderType.Codex>,
): AccountState<typeof ProviderType.Codex> {
  return {
    current: () => freezeAccount(codexPartition(state.current(), "siwc")),
    update: (generation, update) =>
      state.update(generation, (account) => editSiwc(account, update), "siwc"),
    updateAuthorization: (generation, update) =>
      state.updateAuthorization(generation, (account) =>
        editSiwc(account, update),
      ),
    replaceCredentials: (generation, inherit, update) =>
      state.replaceCredentials(
        generation,
        inherit,
        (account) => {
          if (account.session?.siwc?.native_generation !== account.generation)
            throw new OAuthError(
              "The binding target changed; start a new authorization",
              409,
              "account_changed",
            );
          return editSiwc(account, update);
        },
        "siwc",
      ),
    resolve: (rejected) => state.resolve(rejected, "siwc"),
  };
}
