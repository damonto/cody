import { SessionPhase } from "./values.ts";
import { ApiProtocol } from "../protocol-values.ts";
import { HealthFailureScope } from "../health/values.ts";

import {
  healthFailureScope,
  recordCredentialFailure,
  recordProviderFailure,
  recordProviderSuccess,
} from "../health/health.ts";
import type { StoredWebSocketSession, WebSocketStorage } from "./storage.ts";
import type { Bindings } from "../../platform/bindings.ts";

export function shouldRecordUpstreamFailure(
  state: StoredWebSocketSession | undefined,
): boolean {
  return (
    state !== undefined &&
    !state.response_outcome_recorded &&
    (state.phase === SessionPhase.Connecting ||
      (state.phase === SessionPhase.Open && state.active_response))
  );
}

/** Applies OpenAI health outcomes once per active WebSocket response. */
export class WebSocketHealth {
  constructor(
    private readonly env: Bindings,
    private readonly storage: WebSocketStorage,
  ) {}

  async observe(
    state: StoredWebSocketSession,
    status: number | undefined,
  ): Promise<void> {
    if (status === undefined) return;
    const scope = healthFailureScope(
      status,
      ApiProtocol.Openai,
      state.selected_provider_type,
    );
    if (
      scope === HealthFailureScope.Credential &&
      state.selected_provider_id &&
      state.selected_credential_id
    ) {
      await recordCredentialFailure(
        this.env,
        state.selected_provider_id,
        state.selected_credential_id,
        state.request_id,
      );
    } else if (scope === HealthFailureScope.Provider) {
      await this.fail();
    }
  }

  async fail(): Promise<void> {
    const transition = await this.storage.transition(
      [SessionPhase.Connecting, SessionPhase.Open],
      (state) =>
        state.response_outcome_recorded
          ? state
          : { ...state, response_outcome_recorded: true },
    );
    if (
      !transition ||
      transition.previous.response_outcome_recorded ||
      !transition.next.selected_provider_id
    ) {
      return;
    }
    await recordProviderFailure(
      this.env,
      transition.next.selected_provider_id,
      transition.next.request_id,
    );
  }

  async complete(): Promise<void> {
    const transition = await this.storage.transition(
      [SessionPhase.Open],
      (state) => ({
        ...state,
        active_response: false,
        response_outcome_recorded: true,
      }),
    );
    if (
      !transition ||
      transition.previous.response_outcome_recorded ||
      !transition.next.selected_provider_id
    ) {
      return;
    }
    await recordProviderSuccess(
      this.env,
      transition.next.selected_provider_id,
      transition.next.request_id,
    );
  }

  async inactive(): Promise<void> {
    await this.storage.transition([SessionPhase.Open], (state) => ({
      ...state,
      active_response: false,
    }));
  }
}
