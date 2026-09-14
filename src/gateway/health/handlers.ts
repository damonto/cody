import {
  clearCredentialHealth,
  clearProviderHealth,
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
  const allowed = new Set(client.providers);
  const providers = config.providers.filter((provider) =>
    allowed.has(provider.id),
  );
  const data = await listCoolingHealth(env, providers, scope);
  requestLog.set({
    health: {
      action: "list",
      scope,
      cooling_providers: data
        .filter((entry) => !("credential_id" in entry))
        .map((entry) => entry.provider_id),
      cooling_keys: data.flatMap((entry) =>
        "credential_id" in entry
          ? [
              {
                provider_id: entry.provider_id,
                credential_id: entry.credential_id,
              },
            ]
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
  providerId: string,
  credentialId: string | undefined,
  requestLog: RequestLogContext,
): Promise<Response> {
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (!provider || !client.providers.includes(providerId)) {
    requestLog.warn({
      outcome: "provider_not_found",
      health: { action: "clear", provider_id: providerId },
    });
    return openAiError(
      404,
      `Provider ${providerId} is not available for this API key`,
      "invalid_request_error",
      "provider_not_found",
    );
  }
  if (
    credentialId !== undefined &&
    !provider.credentials.some((key) => key.id === credentialId)
  ) {
    requestLog.warn({
      outcome: "key_not_found",
      health: {
        action: "clear",
        provider_id: providerId,
        credential_id: credentialId,
      },
    });
    return openAiError(
      404,
      `Key ${credentialId} is not available in provider ${providerId}`,
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
        provider_id: providerId,
        scope: incomingUrl.searchParams.get("scope"),
      },
    });
    return invalidHealthScope();
  }
  const snapshot =
    credentialId === undefined
      ? await clearProviderHealth(env, providerId, scope)
      : await clearCredentialHealth(env, providerId, credentialId, scope);
  requestLog.set({
    health: {
      action: "clear",
      provider_id: providerId,
      ...(credentialId === undefined ? {} : { credential_id: credentialId }),
      scope,
      ...snapshot,
    },
  });
  return jsonResponse({
    provider_id: providerId,
    ...(credentialId === undefined ? {} : { credential_id: credentialId }),
    scope,
    ...snapshot,
  });
}
