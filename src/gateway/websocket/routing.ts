import {
  isCodexClientRequest,
  codexRequestMode,
} from "../../shared/codex-client.ts";
import { ProviderType } from "../../config/values.ts";
import { ProviderTransport } from "../../providers/transport-values.ts";
import {
  accountReply,
  accountReadinessSchema,
} from "../../providers/oauth/schema.ts";
import { HealthScope } from "../health/values.ts";
import { SessionAffinityStatus } from "../routing/values.ts";

import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";
import { logWarn } from "../../shared/log.ts";
import {
  selectAvailableProviderWithDetails,
  targetIsAvailableForRoute,
  type ModelProviderTarget,
  type ModelRoute,
} from "../routing/routing.ts";
import type { StoredWebSocketSession } from "./storage.ts";
import { gatewayErrorEvent } from "./websocket-protocol.ts";
import type { Bindings } from "../../platform/bindings.ts";

export interface CurrentRoutingContext {
  config: GatewayConfig;
  client: ClientApiKeyConfig;
}

function targetFromRoute(
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

export type CurrentTargetResult =
  | { kind: "ready"; target: ModelProviderTarget }
  | { kind: "changed" }
  | { kind: "affinity_unavailable" };

export async function resolveCurrentTarget(
  env: Bindings,
  state: StoredWebSocketSession,
  route: ModelRoute,
  sessionId: string | undefined,
  client: ClientApiKeyConfig,
): Promise<CurrentTargetResult> {
  const selectedTarget = targetFromRoute(route, state);
  if (!selectedTarget) {
    return { kind: "changed" };
  }
  const request = { headers: new Headers(state.forwarded_headers) };
  const policy = {
    endpoint: "responses" as const,
    transport: ProviderTransport.Websocket,
    client: isCodexClientRequest(request)
      ? ("codex" as const)
      : ("other" as const),
  };
  if (
    selectedTarget.provider.type === ProviderType.Codex &&
    selectedTarget.credential.auth.type === "oauth"
  ) {
    const mode = codexRequestMode(request, selectedTarget.provider.use_siwc);
    if (state.codex_auth_mode !== undefined && mode !== state.codex_auth_mode)
      return { kind: "changed" };
    try {
      const readiness = await accountReply(
        env.PROVIDER_OAUTH_ACCOUNT.getByName(
          selectedTarget.credential.auth.account_ref,
        ).run({ action: "readiness", mode }),
        accountReadinessSchema,
      );
      if (
        !readiness.ready ||
        (state.codex_generation !== undefined &&
          readiness.generation !== state.codex_generation)
      )
        return { kind: "changed" };
    } catch {
      return { kind: "affinity_unavailable" };
    }
  }
  if (!sessionId) {
    return (await targetIsAvailableForRoute(
      env,
      route,
      selectedTarget,
      HealthScope.Inference,
      policy,
    ))
      ? { kind: "ready", target: selectedTarget }
      : { kind: "changed" };
  }
  const selection = await selectAvailableProviderWithDetails(env, route, {
    session: { clientId: client.id, sessionId },
    codexRequest: policy,
  });
  if (selection.affinity?.status === SessionAffinityStatus.Failed) {
    logWarn("websocket.affinity.failed", {
      request_id: state.request_id,
      error: selection.affinity.error,
    });
    return { kind: "affinity_unavailable" };
  }
  const unchanged =
    selection.target?.provider.id === selectedTarget.provider.id &&
    selection.target.credential.id === selectedTarget.credential.id;
  return unchanged
    ? { kind: "ready", target: selectedTarget }
    : { kind: "changed" };
}

export function unavailableTargetError(
  selection: Awaited<ReturnType<typeof selectAvailableProviderWithDetails>>,
  model: string,
): string {
  switch (selection.affinity?.status) {
    case SessionAffinityStatus.Failed:
      return gatewayErrorEvent(
        503,
        "The session binding store is unavailable",
        "session_affinity_unavailable",
      );
    default:
      return gatewayErrorEvent(
        503,
        `No healthy provider is currently available for model ${model}`,
        "provider_cooling_down",
      );
  }
}
