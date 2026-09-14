import type { GatewayConfig } from "../../config/types.ts";
import { credentialSecretValues } from "../../providers/credentials.ts";

const upstreamSecretsByConfig = new WeakMap<GatewayConfig, readonly string[]>();

export function upstreamSecretValues(config: GatewayConfig): readonly string[] {
  const cached = upstreamSecretsByConfig.get(config);
  if (cached) {
    return cached;
  }
  const values = config.providers.flatMap((provider) =>
    provider.credentials.flatMap(credentialSecretValues),
  );
  values.push(
    ...(config.proxy_groups ?? []).flatMap((group) =>
      group.proxies.flatMap((proxy) =>
        proxy.password ? [proxy.password] : [],
      ),
    ),
  );
  const allValues =
    config.web_search.mode === "proxy"
      ? values
      : [...values, config.web_search.api_key];
  upstreamSecretsByConfig.set(config, allValues);
  return allValues;
}
