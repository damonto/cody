import {
  healthFailureScope,
  recordKeyFailure,
  recordServiceFailure,
  recordServiceSuccess,
} from "../health/health.ts";
import type { WebSocketStorage, StoredWebSocketSession } from "./storage.ts";

export function shouldRecordUpstreamFailure(
  state: StoredWebSocketSession | undefined,
): boolean {
  return (
    state !== undefined &&
    !state.response_outcome_recorded &&
    (state.phase === "connecting" ||
      (state.phase === "open" && state.active_response))
  );
}

/** Applies OpenAI health outcomes once per active WebSocket response. */
export class WebSocketHealth {
  constructor(
    private readonly env: Env,
    private readonly storage: WebSocketStorage,
  ) {}

  async observe(
    state: StoredWebSocketSession,
    status: number | undefined,
  ): Promise<void> {
    if (status === undefined) return;
    const scope = healthFailureScope(status, "openai");
    if (scope === "key" && state.selected_service_id && state.selected_key_id) {
      await recordKeyFailure(
        this.env,
        state.selected_service_id,
        state.selected_key_id,
        state.request_id,
      );
    } else if (scope === "service") {
      await this.fail();
    }
  }

  async fail(): Promise<void> {
    const transition = await this.storage.transition(
      ["connecting", "open"],
      (state) =>
        state.response_outcome_recorded
          ? state
          : { ...state, response_outcome_recorded: true },
    );
    if (
      !transition ||
      transition.previous.response_outcome_recorded ||
      !transition.next.selected_service_id
    ) {
      return;
    }
    await recordServiceFailure(
      this.env,
      transition.next.selected_service_id,
      transition.next.request_id,
    );
  }

  async complete(): Promise<void> {
    const transition = await this.storage.transition(["open"], (state) => ({
      ...state,
      active_response: false,
      response_outcome_recorded: true,
    }));
    if (
      !transition ||
      transition.previous.response_outcome_recorded ||
      !transition.next.selected_service_id
    ) {
      return;
    }
    await recordServiceSuccess(
      this.env,
      transition.next.selected_service_id,
      transition.next.request_id,
    );
  }

  async inactive(): Promise<void> {
    await this.storage.transition(["open"], (state) => ({
      ...state,
      active_response: false,
    }));
  }
}
