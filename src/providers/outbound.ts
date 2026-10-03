import { ControlStore } from "../control/store.ts";
import type {
  ProviderConfig,
  ProviderCredentialConfig,
} from "../config/types.ts";
import { createUpstreamTransport } from "../gateway/transport/index.ts";
import {
  proxyConfigurationSchema,
  type ProviderConnection,
  type OAuthProviderType,
  type ProxyConfiguration,
} from "./oauth/schema.ts";
import type { Bindings } from "../platform/bindings.ts";
import { providerTransportPolicy } from "./transport.ts";

export function providerConnection(
  provider: Pick<ProviderConfig, "id" | "proxy_group">,
  credential: Pick<ProviderCredentialConfig, "id" | "proxy_group">,
): ProviderConnection {
  return {
    provider_id: provider.id,
    credential_id: credential.id,
    provider_proxy_group: provider.proxy_group,
    credential_proxy_group: credential.proxy_group,
  };
}

/** Management operations use the same committed configuration as inference. */
export async function currentProxyConfiguration(
  env: Pick<Bindings, "CODY_DB" | "CONFIG_ENCRYPTION_KEY">,
): Promise<ProxyConfiguration> {
  return proxyConfigurationSchema.parse(
    await new ControlStore(env.CODY_DB, env.CONFIG_ENCRYPTION_KEY).committed(),
  );
}

export function providerOutbound(
  connection: ProviderConnection,
  config: ProxyConfiguration,
  env: Pick<Bindings, "PROXY_GROUP" | "UPSTREAM_HTTP">,
  signal: AbortSignal,
  providerType: OAuthProviderType,
) {
  return createUpstreamTransport(
    {
      id: connection.provider_id,
      proxy_group: connection.provider_proxy_group,
    },
    {
      id: connection.credential_id,
      proxy_group: connection.credential_proxy_group,
    },
    { config, env, clientSignal: signal },
    providerTransportPolicy(providerType, env),
  );
}
