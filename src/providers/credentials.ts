import type {
  CredentialAuth,
  ProviderCredentialConfig,
} from "../config/types.ts";

export interface ResolvedCredential {
  readonly token: string;
}

/** Auth-specific lifecycle belongs here; routing uses the stable credential ID. */
export interface CredentialResolver<
  Auth extends CredentialAuth = CredentialAuth,
> {
  readonly type: Auth["type"];
  resolve(auth: Auth): Promise<ResolvedCredential>;
  sensitiveValues(auth: Auth): readonly string[];
}

const apiKeyResolver: CredentialResolver<
  Extract<CredentialAuth, { type: "api_key" }>
> = {
  type: "api_key",
  async resolve(auth) {
    return { token: auth.api_key };
  },
  sensitiveValues: (auth) => [auth.api_key],
};

const resolvers = { api_key: apiKeyResolver } satisfies {
  [Type in CredentialAuth["type"]]: CredentialResolver<
    Extract<CredentialAuth, { type: Type }>
  >;
};

export function resolveCredential(
  credential: ProviderCredentialConfig,
): Promise<ResolvedCredential> {
  return resolvers[credential.auth.type].resolve(credential.auth);
}

export function credentialSecretValues(
  credential: ProviderCredentialConfig,
): readonly string[] {
  return resolvers[credential.auth.type].sensitiveValues(credential.auth);
}
