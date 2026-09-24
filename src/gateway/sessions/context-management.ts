import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";
import {
  prepareProviderRequest,
  providerSupportsEndpoint,
} from "../../providers/index.ts";
import { errorMessage, type RequestLogContext } from "../../shared/log.ts";
import type { HealthExecutionContext } from "../health/health.ts";
import { BodyTooLargeError, readBodyWithinLimit } from "../http/body.ts";
import { apiError } from "../http/http.ts";
import { fetchWithConfiguredRetries } from "../http/proxy.ts";
import { requestProtocol, type ContextManagementPath } from "../protocol.ts";
import { upstreamSecretValues } from "../routing/credentials.ts";
import {
  allowedProviderCandidates,
  resolveModelRoute,
  selectAvailableTargetWithDetails,
} from "../routing/routing.ts";
import { parseContextManagementSession } from "./context-management-protocol.ts";
import type { Bindings } from "../../platform/bindings.ts";

export const MAX_CONTEXT_MANAGEMENT_BODY_BYTES = 4 * 1024 * 1024;

export async function handleContextManagement(
  request: Request,
  env: Bindings,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  path: ContextManagementPath,
  requestId: string,
  requestLog?: RequestLogContext,
  context?: HealthExecutionContext,
): Promise<Response> {
  const protocol = requestProtocol(request, path);
  requestLog?.registerSensitiveValues([
    client.api_key,
    ...upstreamSecretValues(config),
  ]);
  const candidates = allowedProviderCandidates(config, client).filter(
    ({ provider }) => providerSupportsEndpoint(provider, path),
  );
  if (candidates.length === 0) {
    return apiError(
      protocol,
      404,
      "Context management is not enabled for this client",
      { code: "context_management_not_enabled", requestId },
    );
  }

  let body: Uint8Array<ArrayBuffer>;
  let sessionId: string;
  try {
    body = await readBodyWithinLimit(
      request.body,
      MAX_CONTEXT_MANAGEMENT_BODY_BYTES,
      request.headers.get("content-length"),
    );
    sessionId = parseContextManagementSession(
      new TextDecoder().decode(body),
      request.headers.get("session-id"),
    );
  } catch (error) {
    const tooLarge = error instanceof BodyTooLargeError;
    return apiError(
      protocol,
      tooLarge ? 413 : 400,
      tooLarge
        ? "Context management request exceeds the 4 MiB limit"
        : errorMessage(error),
      {
        code: tooLarge
          ? "request_too_large"
          : "invalid_context_management_request",
        requestId,
      },
    );
  }

  const selection = await selectAvailableTargetWithDetails(env, candidates, {
    contextManagement: true,
    // The first hint precedes inference and carries no model. Bootstrap using
    // Astra's effective routes; existing sessions retain their original target.
    initialProviderIds: resolveModelRoute(config, client, "gpt-6-astra", {
      requiredCapabilities: ["supports_context_management"],
    }).targets.map(({ provider }) => provider.id),
    session: { clientId: client.id, sessionId },
  });
  const target = selection.target;
  requestLog?.set({
    routing: {
      candidate_providers: candidates.map(({ provider }) => provider.id),
      affinity: selection.affinity,
      ...(target
        ? {
            selected_provider: target.provider.id,
            selected_credential_id: target.credential.id,
          }
        : {}),
    },
  });
  if (!target) {
    const forbidden = selection.affinity?.status === "forbidden";
    return apiError(
      protocol,
      forbidden ? 403 : 503,
      forbidden
        ? "This context session belongs to another client"
        : "The context session binding is unavailable",
      {
        type: forbidden ? "permission_error" : "server_error",
        code: forbidden
          ? "context_session_forbidden"
          : "context_session_unavailable",
        requestId,
      },
    );
  }

  const prepared = await prepareProviderRequest(
    target.provider,
    target.credential,
    {
      request,
      endpoint: path,
      transport: "http",
      protocol: "openai",
    },
    { config, env, context, requestLog, requestId },
  );
  const { headers } = prepared;
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  // Notes writes are not replayable. Auxiliary calls make one attempt and do
  // not update inference health, including on successful recovery reads.
  const result = await fetchWithConfiguredRetries(
    () =>
      new Request(prepared.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: request.signal,
      }),
    undefined,
    {
      attemptTimeoutMs: 35_000,
      send: prepared.send,
    },
  );
  requestLog?.set({
    outcome: result.response?.ok
      ? "success"
      : "context_management_upstream_error",
    upstream: {
      provider_id: target.provider.id,
      credential_id: target.credential.id,
      attempts: result.attempts,
    },
  });
  const proxyFailure = prepared.proxyFailure(result.error);
  return (
    result.response ??
    apiError(
      protocol,
      proxyFailure?.status ?? 502,
      proxyFailure?.message ??
        "The context management upstream could not be reached",
      {
        type: "server_error",
        code: proxyFailure?.code ?? "upstream_unavailable",
        requestId,
      },
    )
  );
}
