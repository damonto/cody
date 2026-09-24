import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";
import { logWarn } from "../../shared/log.ts";
import {
  selectAvailableProviderWithDetails,
  targetIsAvailableForRoute,
  type ModelProviderTarget,
  type ModelRoute,
} from "../routing/routing.ts";
import {
  contextManagementRequested,
  contextManagementSessionMatches,
} from "../sessions/context-management-protocol.ts";
import type { StoredWebSocketSession } from "./storage.ts";
import {
  gatewayErrorEvent,
  type ResponseCreateFrame,
} from "./websocket-protocol.ts";
import type { Bindings } from "../../platform/bindings.ts";

export interface CurrentRoutingContext {
  config: GatewayConfig;
  client: ClientApiKeyConfig;
}

export function targetFromRoute(
  route: ModelRoute,
  state: StoredWebSocketSession,
): ModelProviderTarget | undefined {
  const routed = route.targets.find(
    ({ provider }) => provider.id === state.selected_provider_id,
  );
  const key = routed?.credentials.find(
    (entry) => entry.id === state.selected_credential_id,
  );
  return routed && key
    ? {
        provider: routed.provider,
        credential: key,
        upstreamModel: routed.upstreamModel,
        routeApplied: routed.routeApplied,
      }
    : undefined;
}

export function frameUsesContextManagement(
  frame: ResponseCreateFrame,
  state: StoredWebSocketSession,
): boolean {
  return (
    state.context_management === true ||
    contextManagementRequested(frame.payload)
  );
}

export function contextSessionIdsMatch(
  frame: ResponseCreateFrame,
  state: StoredWebSocketSession,
  sessionId: string | undefined,
): boolean {
  if (!contextManagementSessionMatches(frame.payload, sessionId)) {
    return false;
  }
  const boundSessionId = state.header_session_id ?? state.current_session_id;
  return !(
    boundSessionId !== undefined &&
    frame.sessionId !== undefined &&
    frame.sessionId !== boundSessionId
  );
}

export async function validateCurrentTarget(
  env: Bindings,
  state: StoredWebSocketSession,
  route: ModelRoute,
  sessionId: string | undefined,
  client: ClientApiKeyConfig,
  contextManagement: boolean,
): Promise<{ valid: boolean; contextManagement: boolean }> {
  const selectedTarget = targetFromRoute(route, state);
  if (!selectedTarget) {
    return { valid: false, contextManagement: false };
  }
  if (!sessionId) {
    return {
      valid:
        !contextManagement &&
        (await targetIsAvailableForRoute(env, route, selectedTarget)),
      contextManagement: false,
    };
  }
  const selection = await selectAvailableProviderWithDetails(env, route, {
    contextManagement,
    session: { clientId: client.id, sessionId },
  });
  if (selection.affinity?.status === "failed") {
    logWarn("websocket.affinity.failed", {
      request_id: state.request_id,
      error: selection.affinity.error,
    });
    return {
      valid: false,
      contextManagement: false,
    };
  }
  return {
    valid:
      selection.target?.provider.id === selectedTarget.provider.id &&
      selection.target.credential.id === selectedTarget.credential.id,
    contextManagement: selection.affinity?.context_management === true,
  };
}

export function unavailableTargetError(
  selection: Awaited<ReturnType<typeof selectAvailableProviderWithDetails>>,
  model: string,
): string {
  switch (selection.affinity?.status) {
    case "forbidden":
      return gatewayErrorEvent(
        403,
        "This context session belongs to another client",
        "context_session_forbidden",
      );
    case "failed":
      return gatewayErrorEvent(
        503,
        "The session binding store is unavailable",
        "session_affinity_unavailable",
      );
    case "blocked":
      return gatewayErrorEvent(
        503,
        "The context session binding is unavailable",
        "context_session_unavailable",
      );
    default:
      return gatewayErrorEvent(
        503,
        `No healthy provider is currently available for model ${model}`,
        "provider_cooling_down",
      );
  }
}
