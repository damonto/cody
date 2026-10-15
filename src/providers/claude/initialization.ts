import type { parseProfile as parseClaudeProfile } from "./api.ts";
import { ProviderType } from "../../config/values.ts";
import { OAuthSessionStatus } from "../oauth/values.ts";
import { OAuthError } from "../oauth/schema.ts";
import type { Stored, Session } from "../oauth/state.ts";
import { completeAuthorization } from "../oauth/initialization.ts";
import { claudeQuotaSyncSchema } from "./account-schema.ts";

export function initializeClaudeAccount(
  account: Stored,
  session: Session,
  profile: ReturnType<typeof parseClaudeProfile>,
  tokens: NonNullable<Session["tokens"]>,
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
  const refreshToken = tokens.refresh_token ?? account.tokens?.refresh_token;
  if (!refreshToken)
    throw new OAuthError(
      "Claude did not return a refresh token; authorize again",
    );
  account.tokens = { ...tokens, refresh_token: refreshToken };
  account.identity = profile.identity;
  account.claude = profile.claude;
  completeAuthorization(account, pending);
  account.claude_quota_sync = claudeQuotaSyncSchema.parse({});
  account.models = [];
  account.models_updated_at = null;
}
