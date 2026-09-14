import type { GatewayConfig } from "../../config/types.ts";
import { credentialSecretValues } from "../../providers/credentials.ts";

const upstreamSecretsByConfig = new WeakMap<GatewayConfig, readonly string[]>();

export function upstreamSecretValues(config: GatewayConfig): readonly string[] {
  const cached = upstreamSecretsByConfig.get(config);
  if (cached) {
    return cached;
  }
  const values = config.providers.flatMap((provider) => [
    ...(provider.proxy?.password ? [provider.proxy.password] : []),
    ...provider.credentials.flatMap((key) => [
      ...credentialSecretValues(key),
      ...(key.proxy?.password ? [key.proxy.password] : []),
    ]),
  ]);
  const allValues =
    config.web_search.mode === "proxy"
      ? values
      : [...values, config.web_search.api_key];
  upstreamSecretsByConfig.set(config, allValues);
  return allValues;
}
