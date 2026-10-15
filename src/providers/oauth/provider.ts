import type { z } from "zod";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import type { Bindings } from "../../platform/bindings.ts";
import type { ObjectContext } from "../../platform/object-context.ts";
import type { AccountCommand } from "./commands.ts";
import {
  OAuthError,
  type OAuthProviderType,
  type ProviderConnection,
  type ProxyConfiguration,
  type ConsumeResetResult,
  type QuotaSnapshot,
  type AccountModel,
  type resolvedOAuthSchema,
  type tokenSchema,
} from "./schema.ts";
import type { Stored, Session, AccountSnapshot } from "./state.ts";
import { equalSecret } from "../../shared/equal-secret.ts";

export type AccountTokens = z.output<typeof tokenSchema>;
export type RefreshTokens = AccountTokens & { refresh_token: string };
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
export type AccountCredential = z.output<typeof resolvedOAuthSchema>;
export type StoredFor<Type extends OAuthProviderType> = Extract<
  Stored,
  { provider_type: Type }
>;
export type AccountSnapshotFor<Type extends OAuthProviderType> = Extract<
  AccountSnapshot,
  { provider_type: Type }
>;
export type AccountObservation = Extract<
  AccountCommand,
  {
    action:
      | "codex_usage"
      | "xai_auth_invalid"
      | "xai_limit"
      | "claude_limit"
      | "claude_usage";
  }
>;

/** Providers can commit only through the account runtime's generation fence. */
export interface AccountState<
  Type extends OAuthProviderType = OAuthProviderType,
> {
  /** Read the immutable committed snapshot without copying large model inventories. */
  current(): AccountSnapshotFor<Type>;
  update(
    generation: number,
    update: (account: StoredFor<Type>) => void | Promise<void>,
  ): Promise<void>;
  updateAuthorization(
    generation: number,
    update: (account: StoredFor<Type>) => void | Promise<void>,
  ): Promise<void>;
  /** Replacements borrowing the active refresh token share its rotation queue. */
  replaceCredentials(
    authorizationGeneration: number,
    inheritRefreshToken: boolean,
    update: (account: StoredFor<Type>) => void | Promise<void>,
  ): Promise<void>;
  resolve(rejected?: {
    generation: number;
    token: string;
  }): Promise<AccountCredential>;
}

/** Transport/configuration selection stays outside provider account policy. */
export interface AccountServices {
  outbound(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<[UpstreamFetch, AbortSignal]>;
  configuredConnection(
    fallback: ProviderConnection,
  ): Promise<{ connection: ProviderConnection; config: ProxyConfiguration }>;
  metadata: Pick<Bindings, "CODY_CONFIG_KV">;
  context: Pick<ObjectContext, "waitUntil">;
}

export interface AccountAuthorization {
  browser?: {
    redirectUri: string;
    url(session: Session): string;
    normalizeCallback(redirect: string): { url: URL | null; state: string };
    exchange(code: string, session: Session): Promise<AccountTokens>;
  };
  device?: {
    ttlMs: number;
    url(session: Session): string | null;
    request(session: Session): Promise<void>;
    poll(): Promise<void>;
    error?(error: unknown): unknown;
  };
  initialize(): Promise<void>;
}

export interface AccountMetadata {
  models(): Promise<AccountModel[]>;
  quota(generation: number): Promise<void>;
  verification?(error: unknown): QuotaSnapshot["verification"];
}

export interface AccountProvider {
  authorization: AccountAuthorization;
  refresh(
    generation: number,
    tokens: RefreshTokens,
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<void>;
  inventory: AccountMetadata;
  observe?(command: AccountObservation): Promise<void>;
  resets?: {
    refresh(): Promise<void>;
    consume(
      redeemRequestId: string,
      creditId?: string,
    ): Promise<ConsumeResetResult>;
  };
  background?: {
    pending(): boolean;
    run(): Promise<void>;
    retry(): Promise<void>;
  };
  recoverUnauthorized?: boolean;
}

function matches<
  Snapshot extends AccountSnapshot,
  Type extends OAuthProviderType,
>(
  account: Snapshot,
  type: Type,
): account is Extract<Snapshot, { provider_type: Type }> {
  return account.provider_type === type;
}

export function providerState<Type extends OAuthProviderType>(
  state: AccountState,
  type: Type,
): AccountState<Type> {
  const checked = <Snapshot extends AccountSnapshot>(
    account: Snapshot,
  ): Extract<Snapshot, { provider_type: Type }> => {
    if (!matches(account, type))
      throw new OAuthError("Account provider changed", 409, "account_changed");
    return account;
  };
  return {
    current: () => checked(state.current()),
    update: (generation, update) =>
      state.update(generation, (account) => update(checked(account))),
    updateAuthorization: (generation, update) =>
      state.updateAuthorization(generation, (account) =>
        update(checked(account)),
      ),
    replaceCredentials: (generation, inheritRefreshToken, update) =>
      state.replaceCredentials(generation, inheritRefreshToken, (account) =>
        update(checked(account)),
      ),
    resolve: (rejected) => state.resolve(rejected),
  };
}

export function browserCallback(redirect: string): {
  url: URL | null;
  state: string;
} {
  const url = URL.parse(redirect);
  return { url, state: url?.searchParams.get("state") ?? "" };
}

export function unavailableIdentity(): never {
  throw new OAuthError(
    "Account identity is unavailable; reconnect this account",
    503,
    "oauth_account_unavailable",
  );
}

/** A grant repeating an active refresh token inherits that token's lifecycle. */
export async function authorizationTokens(
  tokens: AccountTokens,
  ...active: (Pick<AccountTokens, "refresh_token"> | null | undefined)[]
): Promise<AccountTokens> {
  if (!tokens.refresh_token) return tokens;
  for (const previous of active)
    if (
      previous?.refresh_token &&
      (await equalSecret(tokens.refresh_token, previous.refresh_token))
    )
      return { ...tokens, refresh_token: undefined };
  return tokens;
}
