import type { GatewayConfig } from "../../config/types.ts";

const upstreamSecretsByConfig = new WeakMap<GatewayConfig, readonly string[]>();

export function upstreamSecretValues(config: GatewayConfig): readonly string[] {
  const cached = upstreamSecretsByConfig.get(config);
  if (cached) {
    return cached;
  }
  const values = config.services.flatMap((service) => [
    ...(service.proxy?.password ? [service.proxy.password] : []),
    ...service.keys.flatMap((key) => [
      key.api_key,
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
