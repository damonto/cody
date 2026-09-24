import type {
  ProviderConfig,
  ProviderCredentialConfig,
} from "../config/types.ts";
import { createUpstreamTransport } from "../gateway/transport/index.ts";
import {
  proxyConfigurationSchema,
  type ProviderConnection,
  type ProxyConfiguration,
} from "./oauth/schema.ts";
import type { Bindings } from "../platform/bindings.ts";

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

/** Management operations use published nodes, never a draft that could change live proxy health. */
export async function publishedProxyConfiguration(
  env: Pick<Bindings, "CODY_CONFIG_KV" | "CONFIG_KEY">,
): Promise<ProxyConfiguration> {
  const raw = await env.CODY_CONFIG_KV.get(env.CONFIG_KEY ?? "gateway-config");
  return proxyConfigurationSchema.parse(
    raw ? JSON.parse(raw) : { proxy_groups: [] },
  );
}

export function providerOutbound(
  connection: ProviderConnection,
  config: ProxyConfiguration,
  env: Pick<Bindings, "PROXY_GROUP">,
  signal: AbortSignal,
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
  );
}
