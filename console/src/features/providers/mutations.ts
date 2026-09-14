import type {
  GatewayConfig,
  ProviderConfig,
} from "../../../../src/config/types";

export function updateProvider(
  config: GatewayConfig,
  index: number,
  provider: ProviderConfig,
): GatewayConfig {
  const next = structuredClone(config);
  if (index === -1) next.providers.push(provider);
  else next.providers[index] = provider;
  next.model_policies = next.model_policies?.filter(
    (policy) =>
      policy.provider_id !== provider.id ||
      provider.models.includes(policy.model),
  );
  return next;
}
export function removeProvider(
  config: GatewayConfig,
  providerId: string,
): GatewayConfig {
  const next = structuredClone(config);
  next.providers = next.providers.filter(
    (provider) => provider.id !== providerId,
  );
  next.model_policies = next.model_policies?.filter(
    (policy) => policy.provider_id !== providerId,
  );
  return next;
}
