import type { xaiIdentity } from "./api.ts";
import { xaiModels } from "./models.ts";
import { ProviderType } from "../../config/values.ts";
import { OAuthSessionStatus } from "../oauth/values.ts";
import { OAuthError } from "../oauth/schema.ts";
import type { Stored, Session } from "../oauth/state.ts";
import { completeAuthorization } from "../oauth/initialization.ts";

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
