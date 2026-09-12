import type {
  GatewayConfig,
  ServiceConfig,
} from "../../../../src/config/types";

export function updateService(
  config: GatewayConfig,
  index: number,
  service: ServiceConfig,
): GatewayConfig {
  const next = structuredClone(config);
  if (index === -1) next.services.push(service);
  else next.services[index] = service;
  next.model_policies = next.model_policies?.filter(
    (policy) =>
      policy.service_id !== service.id || service.models.includes(policy.model),
  );
  return next;
}
export function removeService(
  config: GatewayConfig,
  serviceId: string,
): GatewayConfig {
  const next = structuredClone(config);
  next.services = next.services.filter((service) => service.id !== serviceId);
  next.model_policies = next.model_policies?.filter(
    (policy) => policy.service_id !== serviceId,
  );
  return next;
}
