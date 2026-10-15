import type { parseIdToken } from "./api.ts";
import { codexQuotaSyncSchema } from "./quota.ts";
import { ProviderType } from "../../config/values.ts";
import { OAuthSessionStatus } from "../oauth/values.ts";
import { OAuthError } from "../oauth/schema.ts";
import type { Stored, Session } from "../oauth/state.ts";
import { completeAuthorization } from "../oauth/initialization.ts";

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
  account.codex_quota_sync = codexQuotaSyncSchema.parse({});
  account.models = [];
  account.models_updated_at = null;
}
