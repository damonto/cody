import type {
  CredentialAuth,
  ProviderConfig,
  ProviderCredentialConfig,
} from "../config/types.ts";
import {
  accountReply,
  OAuthError,
  proxyConfigurationSchema,
  resolvedOAuthSchema,
} from "./oauth/schema.ts";
import { providerConnection } from "./outbound.ts";
import type { ProviderRuntimeContext } from "./types.ts";

export interface ResolvedApiKey {
  readonly type: "api_key";
  readonly token: string;
}
export interface ResolvedOAuth {
  readonly type: "oauth";
  readonly token: string;
  readonly project_id: string;
  readonly account_ref: string;
}
export type ResolvedCredential = ResolvedApiKey | ResolvedOAuth;
export type ResolvedCredentialFor<Auth extends CredentialAuth> = Extract<
  ResolvedCredential,
  { type: Auth["type"] }
>;
export interface CredentialContext extends ProviderRuntimeContext {
  readonly provider: ProviderConfig;
  readonly credential: ProviderCredentialConfig;
}
/** Auth lifecycle is independent of routing and the provider request codec. */
export interface CredentialResolver<Auth extends CredentialAuth> {
  readonly type: Auth["type"];
  resolve(
    auth: Auth,
    context?: CredentialContext,
  ): Promise<ResolvedCredentialFor<Auth>>;
  sensitiveValues(auth: Auth): readonly string[];
}
const apiKeyResolver: CredentialResolver<
  Extract<CredentialAuth, { type: "api_key" }>
> = {
  type: "api_key",
  async resolve(auth) {
    return { type: "api_key", token: auth.api_key };
  },
  sensitiveValues: (auth) => [auth.api_key],
};
const oauthResolver: CredentialResolver<
  Extract<CredentialAuth, { type: "oauth" }>
> = {
  type: "oauth",
  async resolve(auth, context) {
    if (!context || context.provider.type !== "antigravity")
      throw new OAuthError("OAuth account storage is unavailable", 503);
    const token = await accountReply(
      context.env.PROVIDER_OAUTH_ACCOUNT.getByName(auth.account_ref).run({
        action: "resolve",
        connection: providerConnection(context.provider, context.credential),
        proxy_configuration: proxyConfigurationSchema.parse(context.config),
      }),
      resolvedOAuthSchema,
    );
    context.requestLog?.registerSensitiveValues([token.token]);
    return { type: "oauth", ...token, account_ref: auth.account_ref };
  },
  sensitiveValues: () => [],
};
export function resolveCredential(
  credential: ProviderCredentialConfig,
  context?: CredentialContext,
): Promise<ResolvedCredential> {
  return credential.auth.type === "api_key"
    ? apiKeyResolver.resolve(credential.auth, context)
    : oauthResolver.resolve(credential.auth, context);
}
export function credentialSecretValues(
  credential: ProviderCredentialConfig,
): readonly string[] {
  return credential.auth.type === "api_key"
    ? apiKeyResolver.sensitiveValues(credential.auth)
    : oauthResolver.sensitiveValues(credential.auth);
}
