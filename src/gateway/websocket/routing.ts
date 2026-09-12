import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";
import { logWarn } from "../../shared/log.ts";
import {
  contextManagementRequested,
  contextManagementSessionMatches,
} from "../sessions/context-management-protocol.ts";
import {
  selectAvailableServiceWithDetails,
  targetIsAvailableForRoute,
  type ModelRoute,
  type ModelServiceTarget,
} from "../routing/routing.ts";
import {
  gatewayErrorEvent,
  type ResponseCreateFrame,
} from "./websocket-protocol.ts";
import type { StoredWebSocketSession } from "./storage.ts";

export interface CurrentRoutingContext {
  config: GatewayConfig;
  client: ClientApiKeyConfig;
}

export function targetFromRoute(
  route: ModelRoute,
  state: StoredWebSocketSession,
): ModelServiceTarget | undefined {
  const routed = route.targets.find(
    ({ service }) => service.id === state.selected_service_id,
  );
  const key = routed?.keys.find((entry) => entry.id === state.selected_key_id);
  return routed && key
    ? {
        service: routed.service,
        key,
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
  env: Env,
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
  const selection = await selectAvailableServiceWithDetails(env, route, {
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
      selection.target?.service.id === selectedTarget.service.id &&
      selection.target.key.id === selectedTarget.key.id,
    contextManagement: selection.affinity?.context_management === true,
  };
}

export function unavailableTargetError(
  selection: Awaited<ReturnType<typeof selectAvailableServiceWithDetails>>,
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
        `No healthy service is currently available for model ${model}`,
        "service_cooling_down",
      );
  }
}
