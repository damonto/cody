import type { xaiIdentity } from "../xai/api.ts";
import { xaiModels } from "../xai/models.ts";
import type { parseProfile as parseClaudeProfile } from "../claude/api.ts";
import { OAuthSessionStatus, OAuthAccountStatus } from "./values.ts";
import { ProviderType } from "../../config/values.ts";

import type { parseIdToken } from "../codex/api.ts";

import { OAuthError } from "./schema.ts";

import { emptyQuota, type Stored, type Session } from "./state.ts";
export function initializeCodexAccount(
  account: Stored,
  session: Session,
  claims: ReturnType<typeof parseIdToken>,
  identity: NonNullable<Stored["identity"]>,
): void {
  if (account.provider_type !== ProviderType.Codex)
    throw new OAuthError("Account provider changed", 409);
  const pending = account.session;
  if (
    !pending ||
    pending.id !== session.id ||
    pending.status !== OAuthSessionStatus.Initializing ||
    !pending.tokens
  )
    throw new OAuthError("Authorization was cancelled", 409);
  if (Date.now() >= pending.expires_at)
    throw new OAuthError("Authorization session expired; start again", 410);
  const refreshToken =
    pending.tokens.refresh_token ?? account.tokens?.refresh_token;
  if (!refreshToken)
    throw new OAuthError(
      "ChatGPT did not return a refresh token; start authorization again",
    );
  account.tokens = { ...pending.tokens, refresh_token: refreshToken };
  account.identity = identity;
  account.codex = {
    account_id: claims.account_id,
    ...(claims.is_fedramp ? { is_fedramp: true } : {}),
    user_id: claims.user_id,
    plan_type: claims.plan_type,
    subscription_active_until: claims.subscription_active_until,
  };
  completeAuthorization(account, pending);
  account.models = [];
  account.models_updated_at = null;
}

export function initializeClaudeAccount(
  account: Stored,
  session: Session,
  profile: ReturnType<typeof parseClaudeProfile>,
): void {
  if (account.provider_type !== ProviderType.Claude)
    throw new OAuthError("Account provider changed", 409);
  const pending = account.session;
  if (
    !pending ||
    pending.id !== session.id ||
    pending.status !== OAuthSessionStatus.Initializing ||
    !pending.tokens
  )
    throw new OAuthError("Authorization was cancelled", 409);
  if (Date.now() >= pending.expires_at)
    throw new OAuthError("Authorization session expired", 410);
  const refreshToken =
    pending.tokens.refresh_token ?? account.tokens?.refresh_token;
  if (!refreshToken)
    throw new OAuthError(
      "Claude did not return a refresh token; authorize again",
    );
  account.tokens = { ...pending.tokens, refresh_token: refreshToken };
  account.identity = profile.identity;
  account.claude = profile.claude;
  completeAuthorization(account, pending);
  account.models = [];
  account.models_updated_at = null;
}

export function initializeXaiAccount(
  account: Stored,
  session: Session,
  claims: ReturnType<typeof xaiIdentity>,
  tokens: NonNullable<Session["tokens"]>,
): void {
  if (account.provider_type !== ProviderType.Xai)
    throw new OAuthError("Account provider changed", 409);
  const pending = account.session;
  if (
    !pending ||
    pending.id !== session.id ||
    pending.status !== OAuthSessionStatus.Initializing ||
    Date.now() >= pending.expires_at
  )
    throw new OAuthError("Authorization session is no longer active", 410);
  const refresh_token = tokens.refresh_token ?? account.tokens?.refresh_token;
  if (!refresh_token)
    throw new OAuthError("xAI did not return a refresh token; authorize again");
  account.tokens = { ...tokens, refresh_token };
  account.identity = { id: claims.sub, email: claims.email ?? null };
  account.xai = { subject: claims.sub };
  completeAuthorization(account, pending);
  account.models = xaiModels();
  account.models_updated_at = Date.now();
  pending.xai_device = undefined;
}

/** Called only within the account core's generation-fenced commit. */
function completeAuthorization(account: Stored, pending: Session): void {
  account.connection = pending.connection;
  account.status = OAuthAccountStatus.Ready;
  account.error = null;
  account.generation++;
  account.quota = emptyQuota();
  account.models_error = null;
  pending.status = OAuthSessionStatus.Complete;
  pending.tokens = null;
  pending.state = "";
  pending.verifier = "";
}
