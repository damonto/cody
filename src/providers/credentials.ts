import { CredentialAuthType, ProviderType } from "../config/values.ts";

import type {
  CredentialAuth,
  ProviderConfig,
  ProviderCredentialConfig,
} from "../config/types.ts";
import { antigravityCredentialSchema } from "./antigravity/account-schema.ts";
import { codexCredentialSchema } from "./codex/account-schema.ts";
import { claudeCredentialSchema } from "./claude/account-schema.ts";
import { xaiCredentialSchema } from "./xai/account-schema.ts";
import {
  accountReply,
  OAuthError,
  proxyConfigurationSchema,
  resolvedOAuthSchema,
} from "./oauth/schema.ts";
import { providerConnection } from "./outbound.ts";
import type { ProviderRuntimeContext } from "./types.ts";

export interface ResolvedApiKey {
  readonly type: typeof CredentialAuthType.ApiKey;
  readonly token: string;
}
export interface ResolvedAntigravityOAuth {
  readonly type: typeof CredentialAuthType.OAuth;
  readonly provider: typeof ProviderType.Antigravity;
  readonly token: string;
  readonly project_id: string;
  readonly account_ref: string;
}
export interface ResolvedNativeCodexOAuth {
  readonly mode?: "native";
  readonly generation: number;
  readonly type: typeof CredentialAuthType.OAuth;
  readonly provider: typeof ProviderType.Codex;
  readonly token: string;
  readonly account_id: string;
  readonly is_fedramp?: boolean;
  readonly account_ref: string;
}
export interface ResolvedSiwcOAuth {
  readonly mode: "siwc";
  readonly generation: number;
  readonly type: typeof CredentialAuthType.OAuth;
  readonly provider: typeof ProviderType.Codex;
  readonly token: string;
  readonly siwc_subject: string;
  readonly account_ref: string;
}
export type ResolvedCodexOAuth = ResolvedNativeCodexOAuth | ResolvedSiwcOAuth;
export interface ResolvedClaudeOAuth {
  readonly generation: number;
  readonly type: typeof CredentialAuthType.OAuth;
  readonly provider: typeof ProviderType.Claude;
  readonly token: string;
  readonly account_ref: string;
}
export interface ResolvedXaiOAuth {
  readonly type: typeof CredentialAuthType.OAuth;
  readonly provider: typeof ProviderType.Xai;
  readonly token: string;
  readonly subject: string;
  readonly account_ref: string;
  readonly generation: number;
}
export type ResolvedOAuth =
  | ResolvedAntigravityOAuth
  | ResolvedCodexOAuth
  | ResolvedClaudeOAuth
  | ResolvedXaiOAuth;
export type ResolvedCredential = ResolvedApiKey | ResolvedOAuth;
export type ResolvedCredentialFor<Auth extends CredentialAuth> = Extract<
  ResolvedCredential,
  { type: Auth["type"] }
>;
/** The credential shape each provider adapter receives after resolution. */
export type ResolvedCredentialForProvider<Type extends ProviderType> =
  Type extends typeof ProviderType.AiGateway
    ? ResolvedApiKey
    : Extract<ResolvedOAuth, { provider: Type }>;

export function credentialMatchesProvider<Type extends ProviderType>(
  credential: ResolvedCredential,
  type: Type,
): credential is ResolvedCredentialForProvider<Type> {
  return type === ProviderType.AiGateway
    ? credential.type === CredentialAuthType.ApiKey
    : credential.type === CredentialAuthType.OAuth &&
        credential.provider === type;
}

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
  Extract<CredentialAuth, { type: typeof CredentialAuthType.ApiKey }>
> = {
  type: CredentialAuthType.ApiKey,
  async resolve(auth) {
    return { type: CredentialAuthType.ApiKey, token: auth.api_key };
  },
  sensitiveValues: (auth) => [auth.api_key],
};
const oauthResolver: CredentialResolver<
  Extract<CredentialAuth, { type: typeof CredentialAuthType.OAuth }>
> = {
  type: CredentialAuthType.OAuth,
  async resolve(auth, context) {
    const provider = context?.provider.type;
    if (
      !context ||
      (provider !== ProviderType.Antigravity &&
        provider !== ProviderType.Codex &&
        provider !== ProviderType.Claude &&
        provider !== ProviderType.Xai)
    )
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
    const account_ref = auth.account_ref;
    if (provider === ProviderType.Xai) {
      const value = xaiCredentialSchema.parse(token);
      return {
        type: CredentialAuthType.OAuth,
        provider,
        token: token.token,
        account_ref,
        subject: value.xai_subject,
        generation: value.generation,
      };
    }
    if (provider === ProviderType.Claude) {
      const value = claudeCredentialSchema.parse(token);
      return {
        type: CredentialAuthType.OAuth,
        provider,
        token: token.token,
        account_ref,
        generation: value.generation,
      };
    }
    if (provider === ProviderType.Codex) {
      const parsed = codexCredentialSchema.parse(token);
      if (parsed.mode === "siwc")
        return {
          ...parsed,
          type: CredentialAuthType.OAuth,
          provider,
          account_ref,
        };
      const { account_id, is_fedramp, generation } = parsed;
      return {
        type: CredentialAuthType.OAuth,
        provider,
        token: token.token,
        account_id,
        generation,
        ...(is_fedramp ? { is_fedramp: true } : {}),
        account_ref,
      };
    }
    const { project_id } = antigravityCredentialSchema.parse(token);
    return {
      type: CredentialAuthType.OAuth,
      provider,
      token: token.token,
      project_id,
      account_ref,
    };
  },
  sensitiveValues: () => [],
};
export function resolveCredential(
  credential: ProviderCredentialConfig,
  context?: CredentialContext,
): Promise<ResolvedCredential> {
  return credential.auth.type === CredentialAuthType.ApiKey
    ? apiKeyResolver.resolve(credential.auth, context)
    : oauthResolver.resolve(credential.auth, context);
}
export function credentialSecretValues(
  credential: ProviderCredentialConfig,
): readonly string[] {
  return credential.auth.type === CredentialAuthType.ApiKey
    ? apiKeyResolver.sensitiveValues(credential.auth)
    : oauthResolver.sensitiveValues(credential.auth);
}
