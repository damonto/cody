import {
  clearKeyHealth,
  clearServiceHealth,
  listCoolingHealth,
  type HealthScope,
} from "./health.ts";
import { jsonResponse, openAiError } from "../http/http.ts";
import type { RequestLogContext } from "../../shared/log.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";

function healthScope(incomingUrl: URL): HealthScope | undefined {
  const scope = incomingUrl.searchParams.get("scope") ?? "inference";
  return scope === "inference" || scope === "catalog" ? scope : undefined;
}

function invalidHealthScope(): Response {
  return openAiError(
    400,
    "scope must be inference or catalog",
    "invalid_request_error",
    "invalid_health_scope",
  );
}

export async function handleHealthList(
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  requestLog: RequestLogContext,
): Promise<Response> {
  const scope = healthScope(incomingUrl);
  if (!scope) {
    requestLog.warn({
      outcome: "invalid_health_scope",
      health: { action: "list", scope: incomingUrl.searchParams.get("scope") },
    });
    return invalidHealthScope();
  }
  const allowed = new Set(client.services);
  const services = config.services.filter((service) => allowed.has(service.id));
  const data = await listCoolingHealth(env, services, scope);
  requestLog.set({
    health: {
      action: "list",
      scope,
      cooling_services: data
        .filter((entry) => !("key_id" in entry))
        .map((entry) => entry.service_id),
      cooling_keys: data.flatMap((entry) =>
        "key_id" in entry
          ? [{ service_id: entry.service_id, key_id: entry.key_id }]
          : [],
      ),
    },
  });
  return jsonResponse({
    object: "list",
    scope,
    data,
  });
}

export async function handleHealthClear(
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  serviceId: string,
  keyId: string | undefined,
  requestLog: RequestLogContext,
): Promise<Response> {
  const service = config.services.find((entry) => entry.id === serviceId);
  if (!service || !client.services.includes(serviceId)) {
    requestLog.warn({
      outcome: "service_not_found",
      health: { action: "clear", service_id: serviceId },
    });
    return openAiError(
      404,
      `Service ${serviceId} is not available for this API key`,
      "invalid_request_error",
      "service_not_found",
    );
  }
  if (keyId !== undefined && !service.keys.some((key) => key.id === keyId)) {
    requestLog.warn({
      outcome: "key_not_found",
      health: { action: "clear", service_id: serviceId, key_id: keyId },
    });
    return openAiError(
      404,
      `Key ${keyId} is not available in service ${serviceId}`,
      "invalid_request_error",
      "key_not_found",
    );
  }
  const scope = healthScope(incomingUrl);
  if (!scope) {
    requestLog.warn({
      outcome: "invalid_health_scope",
      health: {
        action: "clear",
        service_id: serviceId,
        scope: incomingUrl.searchParams.get("scope"),
      },
    });
    return invalidHealthScope();
  }
  const snapshot =
    keyId === undefined
      ? await clearServiceHealth(env, serviceId, scope)
      : await clearKeyHealth(env, serviceId, keyId, scope);
  requestLog.set({
    health: {
      action: "clear",
      service_id: serviceId,
      ...(keyId === undefined ? {} : { key_id: keyId }),
      scope,
      ...snapshot,
    },
  });
  return jsonResponse({
    service_id: serviceId,
    ...(keyId === undefined ? {} : { key_id: keyId }),
    scope,
    ...snapshot,
  });
}
