import { BodyTooLargeError, readBodyWithinLimit } from "./body.ts";
import { parseContextManagementSession } from "./context-management-protocol.ts";
import { upstreamApiKeyValues } from "./credentials.ts";
import { apiError, forwardRequestHeaders, upstreamUrl } from "./http.ts";
import { errorMessage, type RequestLogContext } from "./log.ts";
import { requestProtocol, type ContextManagementPath } from "./protocol.ts";
import { fetchWithConfiguredRetries } from "./proxy.ts";
import {
  allowedServiceCandidates,
  resolveModelRoute,
  selectAvailableTargetWithDetails,
} from "./routing.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "./types.ts";

export const MAX_CONTEXT_MANAGEMENT_BODY_BYTES = 4 * 1024 * 1024;

export async function handleContextManagement(
  request: Request,
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  path: ContextManagementPath,
  requestId: string,
  requestLog?: RequestLogContext,
): Promise<Response> {
  const protocol = requestProtocol(request, path);
  requestLog?.registerSensitiveValues([
    client.api_key,
    ...upstreamApiKeyValues(config),
  ]);
  const candidates = allowedServiceCandidates(config, client).filter(
    ({ service }) => service.supports_context_management,
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
    initialServiceIds: resolveModelRoute(config, client, "gpt-6-astra", {
      requiredCapabilities: ["supports_context_management"],
    }).targets.map(({ service }) => service.id),
    session: { clientId: client.id, sessionId },
  });
  const target = selection.target;
  requestLog?.set({
    routing: {
      candidate_services: candidates.map(({ service }) => service.id),
      affinity: selection.affinity,
      ...(target
        ? {
            selected_service: target.service.id,
            selected_key_id: target.key.id,
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

  const headers = forwardRequestHeaders(request, target.key.api_key);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  // Notes writes are not replayable. Auxiliary calls make one attempt and do
  // not update inference health, including on successful recovery reads.
  const result = await fetchWithConfiguredRetries(
    () =>
      new Request(
        upstreamUrl(target.service, path, new URL(request.url).search),
        {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: request.signal,
        },
      ),
    undefined,
    { attemptTimeoutMs: 35_000 },
  );
  requestLog?.set({
    outcome: result.response?.ok
      ? "success"
      : "context_management_upstream_error",
    upstream: {
      service_id: target.service.id,
      key_id: target.key.id,
      attempts: result.attempts,
    },
  });
  return (
    result.response ??
    apiError(
      protocol,
      502,
      "The context management upstream could not be reached",
      { type: "server_error", code: "upstream_unavailable", requestId },
    )
  );
}
