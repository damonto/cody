import { DurableObject } from "cloudflare:workers";
import { WebSocketHealth, shouldRecordUpstreamFailure } from "./health.ts";
import { UpstreamWebSocket } from "./upstream.ts";
import {
  WebSocketStorage,
  LIVE_PHASES,
  type SessionPhase,
  type StoredWebSocketSession,
} from "./storage.ts";
import { WebSocketUsage } from "./usage.ts";
import {
  contextSessionIdsMatch,
  frameUsesContextManagement,
  targetFromRoute,
  unavailableTargetError,
  validateCurrentTarget,
  type CurrentRoutingContext,
} from "./routing.ts";

import { loadConfig } from "../../config/store.ts";
import { webSocketUsageSink } from "../../telemetry/delivery.ts";
import { contextManagementSessionMatches } from "../sessions/context-management-protocol.ts";
import { healthFailureScope } from "../health/health.ts";
import {
  findClientApiKeyByDigest,
  forwardableWebSocketHeaders,
} from "../http/http.ts";
import {
  bounded,
  configureLogging,
  errorMessage,
  logError,
  logInfo,
  logWarn,
} from "../../shared/log.ts";
import { UpstreamAttemptTimeoutError } from "../http/proxy.ts";
import {
  resolveModelRoute,
  selectAvailableProviderWithDetails,
  type ModelRoute,
  type ModelProviderTarget,
} from "../routing/routing.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";
import {
  RESPONSES_WEBSOCKET_CLIENT_DIGEST_HEADER,
  RESPONSES_WEBSOCKET_REQUEST_ID_HEADER,
} from "./websocket-metadata.ts";
import {
  clientFrame,
  closeSocket,
  errorStatus,
  gatewayErrorEvent,
  messageBytes,
  nonBlankString,
  nonEmptyString,
  parseObject,
  rewriteResponseCreate,
  safeSend,
  upstreamErrorText,
  type ResponseCreateFrame,
  type WebSocketMessage,
} from "./websocket-protocol.ts";

const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_PENDING_WEBSOCKET_BYTES = 32 * 1024 * 1024;

type SocketRole = "client" | "upstream";
interface SocketAttachment {
  role: SocketRole;
}

function isSocketRole(value: unknown): value is SocketRole {
  return value === "client" || value === "upstream";
}

function socketAttachment(value: unknown): SocketAttachment | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const role = Reflect.get(value, "role");
  return isSocketRole(role) ? { role } : undefined;
}

function requestIdFrom(request: Request): string | undefined {
  return nonEmptyString(
    request.headers.get(RESPONSES_WEBSOCKET_REQUEST_ID_HEADER),
  );
}

function clientDigestFrom(request: Request): string | undefined {
  const digest = request.headers.get(RESPONSES_WEBSOCKET_CLIENT_DIGEST_HEADER);
  return digest && /^[a-f0-9]{64}$/i.test(digest)
    ? digest.toLowerCase()
    : undefined;
}

function requestOutcomeOnClose(code: number, outcome: string) {
  if (outcome.startsWith("client_")) return "cancelled";
  return code === 1000 ? "incomplete" : "failed";
}

export class ResponsesWebSocketProxy extends DurableObject<Env> {
  private pendingClientBytes = 0;
  private clientMessages = Promise.resolve();
  private readonly upstream: UpstreamWebSocket;
  private readonly health: WebSocketHealth;
  private readonly storage: WebSocketStorage;
  private readonly usage: WebSocketUsage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
    this.storage = new WebSocketStorage(this.ctx.storage);
    this.health = new WebSocketHealth(this.env, this.storage);
    this.upstream = new UpstreamWebSocket(this.env, this.ctx, {
      message: (message, receivedAt) =>
        this.processUpstreamMessage(message, receivedAt),
      close: (event) => this.handleUpstreamClose(event),
      error: () => this.handleUpstreamError(),
      failure: () =>
        this.closeAll(
          1011,
          "upstream event processing failed",
          "upstream_event_processing_failed",
        ),
    });
    this.usage = new WebSocketUsage(
      this.storage,
      this.env.USAGE_QUEUE ? webSocketUsageSink(this.env) : undefined,
      this.ctx,
    );
    if (this.env.USAGE_QUEUE) {
      // Only local storage work runs under the constructor's input gate.
      void this.ctx.blockConcurrencyWhile(async () => {
        await this.storage.recoverUsage();
        this.ctx.waitUntil(this.usage.flush());
      });
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Expected a WebSocket upgrade", { status: 400 });
    }
    const requestId = requestIdFrom(request);
    const clientDigest = clientDigestFrom(request);
    if (!requestId || !clientDigest) {
      return new Response("Missing internal WebSocket metadata", {
        status: 400,
      });
    }
    const forwardedHeaders = forwardableWebSocketHeaders(request);
    const headerSessionId = nonBlankString(request.headers.get("session-id"));
    const state: StoredWebSocketSession = {
      version: 2,
      phase: "awaiting_first_frame",
      request_id: requestId,
      started_at: Date.now(),
      first_frame_deadline: Date.now() + FIRST_FRAME_TIMEOUT_MS,
      incoming_search: new URL(request.url).search,
      forwarded_headers: [...forwardedHeaders.entries()],
      client_api_key_digest: clientDigest,
      ...(headerSessionId ? { header_session_id: headerSessionId } : {}),
      active_response: false,
      response_outcome_recorded: false,
    };
    if (!(await this.storage.createSession(state))) {
      return new Response("WebSocket session already exists", { status: 409 });
    }

    const pair = new WebSocketPair();
    try {
      this.ctx.acceptWebSocket(pair[1], ["client"]);
      pair[1].serializeAttachment({
        role: "client",
      } satisfies SocketAttachment);
    } catch (error) {
      await this.storage.clearSession();
      logError("websocket.accept.failed", {
        request_id: requestId,
        error: errorMessage(error),
      });
      throw error;
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async alarm(): Promise<void> {
    await this.usage.flush();
    const state = await this.storage.loadSession();
    if (state?.phase !== "awaiting_first_frame") {
      await this.storage.scheduleAlarm();
      return;
    }
    if (state.first_frame_deadline > Date.now()) {
      await this.storage.scheduleAlarm();
      return;
    }
    await this.closeAll(
      1008,
      "response.create timeout",
      "first_frame_timeout",
      ["awaiting_first_frame"],
      gatewayErrorEvent(
        408,
        "A response.create frame was not received in time",
        "websocket_first_frame_timeout",
      ),
    );
  }

  private socketRole(socket: WebSocket): SocketRole | undefined {
    const attachment = socketAttachment(socket.deserializeAttachment());
    if (attachment) {
      return attachment.role;
    }
    return this.ctx.getTags(socket).find(isSocketRole);
  }

  private clientSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets("client")[0];
  }

  private async closeAll(
    code: number,
    reason: string,
    outcome: string,
    expectedPhases: readonly SessionPhase[] = LIVE_PHASES,
    clientMessage?: WebSocketMessage,
  ): Promise<void> {
    const transition = await this.storage.transition(
      expectedPhases,
      (state) => ({
        ...state,
        phase: "closed",
      }),
    );
    if (!transition) {
      return;
    }

    if (clientMessage !== undefined) {
      safeSend(this.clientSocket(), clientMessage);
    }
    this.upstream.close(code, reason);
    closeSocket(this.clientSocket(), code, reason);

    const state = transition.previous;
    this.usage.finishAll(requestOutcomeOnClose(code, outcome), outcome);
    const fields = {
      request_id: state.request_id,
      outcome,
      close_code: code,
      phase: state.phase,
      active_response: state.active_response,
      duration_ms: Math.max(0, Date.now() - state.started_at),
      ...(state.selected_provider_id && state.selected_credential_id
        ? {
            provider_id: state.selected_provider_id,
            credential_id: state.selected_credential_id,
          }
        : {}),
    };
    if (
      code === 1000 &&
      (outcome === "client_closed" || outcome === "upstream_closed")
    ) {
      logInfo("websocket.closed", fields);
    } else {
      logWarn("websocket.closed", fields);
    }

    // Every connection gets a unique object ID. Once both sockets are closing,
    // no future request can legitimately reuse this state.
    await this.storage.clearSession();
  }

  private async currentRoutingContext(
    state: StoredWebSocketSession,
  ): Promise<CurrentRoutingContext | undefined> {
    let config: GatewayConfig;
    let client: ClientApiKeyConfig | undefined;
    try {
      config = await loadConfig(this.env);
      client = await findClientApiKeyByDigest(
        state.client_api_key_digest,
        config.api_keys,
      );
    } catch (error) {
      logWarn("websocket.configuration_refresh.failed", {
        request_id: state.request_id,
        error: errorMessage(error),
      });
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          503,
          "The gateway configuration is temporarily unavailable; reconnect the WebSocket",
          "configuration_unavailable",
        ),
      );
      await this.closeAll(
        1012,
        "gateway configuration unavailable",
        "configuration_unavailable",
      );
      return undefined;
    }

    if (!client) {
      logWarn("websocket.authentication_revoked", {
        request_id: state.request_id,
      });
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          401,
          "The client API key is no longer valid",
          "invalid_api_key",
        ),
      );
      await this.closeAll(
        1008,
        "client authentication is no longer valid",
        "authentication_revoked",
      );
      return undefined;
    }
    return { config, client };
  }

  private async processUpstreamMessage(
    message: WebSocketMessage,
    receivedAt = Date.now(),
  ): Promise<void> {
    const state = await this.storage.loadSession();
    if (state?.phase !== "open") {
      return;
    }
    const payload =
      typeof message === "string" ? parseObject(message) : undefined;
    const status = payload ? errorStatus(payload) : undefined;
    const meter = payload ? this.usage.observe(payload, receivedAt) : undefined;
    await this.health.observe(state, status);

    if (!safeSend(this.clientSocket(), message)) {
      await this.closeAll(
        1011,
        "client websocket unavailable",
        "client_socket_unavailable",
      );
      return;
    }
    if (!payload) {
      return;
    }

    if (payload.type === "response.completed") {
      if (meter) {
        this.usage.finish(meter, "success");
      }
      await this.health.complete();
      return;
    }
    if (
      payload.type === "response.failed" ||
      payload.type === "response.incomplete"
    ) {
      if (meter) {
        this.usage.finish(
          meter,
          payload.type === "response.failed" ? "failed" : "incomplete",
          status ?? null,
        );
      }
      await this.health.inactive();
      return;
    }
    if (payload.type === "error") {
      if (meter) {
        this.usage.finish(meter, "failed", status ?? null);
      }
      await this.health.inactive();
      // Codex frame status, as above.
      const keyFailure =
        status !== undefined &&
        healthFailureScope(status, "openai") === "credential";
      await this.closeAll(
        1011,
        keyFailure
          ? "selected upstream key is cooling down"
          : "upstream returned an error",
        keyFailure ? "key_cooling_down" : "upstream_error",
      );
    }
  }

  private async handleUpstreamClose(event: CloseEvent): Promise<void> {
    const state = await this.storage.loadSession();
    const upstreamFailed = shouldRecordUpstreamFailure(state);
    if (upstreamFailed) {
      await this.health.fail();
    }
    const outcome =
      state?.phase === "connecting" && upstreamFailed
        ? "upstream_closed_during_connect"
        : upstreamFailed
          ? "upstream_closed_during_response"
          : "upstream_closed";
    await this.closeAll(
      event.code,
      event.reason || "upstream websocket closed",
      outcome,
    );
  }

  private async handleUpstreamError(): Promise<void> {
    const state = await this.storage.loadSession();
    if (shouldRecordUpstreamFailure(state)) {
      await this.health.fail();
    }
    await this.closeAll(
      1011,
      "upstream websocket error",
      "upstream_socket_error",
    );
  }

  private async connectUpstream(
    originalMessage: string,
    frame: ResponseCreateFrame,
    route: ModelRoute,
    target: ModelProviderTarget,
    sessionId: string | undefined,
    contextManagement: boolean,
    config: GatewayConfig,
  ): Promise<void> {
    const connecting = await this.storage.transition(["routing"], (state) => ({
      ...state,
      phase: "connecting",
      ...(sessionId ? { current_session_id: sessionId } : {}),
      selected_provider_id: target.provider.id,
      selected_credential_id: target.credential.id,
      ...(contextManagement ? { context_management: true } : {}),
    }));
    if (!connecting) {
      return;
    }

    const result = await this.upstream.connect(connecting.next, target, config);

    const current = await this.storage.loadSession();
    if (current?.phase !== "connecting") {
      const socket = result.response?.webSocket;
      if (socket) {
        // A late upgrade has not been accepted by the upstream transport yet.
        socket.accept();
        closeSocket(socket, 1000, "client disconnected");
      }
      return;
    }
    if (!result.response) {
      const timedOut = result.error instanceof UpstreamAttemptTimeoutError;
      if (!result.proxyError) await this.health.fail();
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          result.proxyError?.status ?? (timedOut ? 504 : 502),
          result.proxyError?.message ??
            (timedOut
              ? "The selected upstream WebSocket handshake timed out"
              : "The selected upstream WebSocket could not be reached"),
          result.proxyError?.code ??
            (timedOut ? "upstream_handshake_timeout" : "upstream_unavailable"),
        ),
      );
      logWarn(
        timedOut
          ? "websocket.upstream_handshake_timeout"
          : "websocket.upstream_unavailable",
        {
          request_id: current.request_id,
          provider_id: target.provider.id,
          credential_id: target.credential.id,
          attempts: result.attempts,
          error: errorMessage(result.error),
        },
      );
      await this.closeAll(
        1011,
        timedOut
          ? "upstream websocket handshake timed out"
          : "upstream websocket unavailable",
        timedOut ? "upstream_handshake_timeout" : "upstream_unavailable",
      );
      return;
    }

    const response = result.response;
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      if (healthFailureScope(response.status, "openai") === "provider") {
        await this.health.fail();
      }
      const body = await upstreamErrorText(response);
      safeSend(
        this.clientSocket(),
        body ??
          gatewayErrorEvent(
            response.status || 502,
            `Upstream WebSocket upgrade failed with status ${response.status}`,
            "websocket_upgrade_failed",
          ),
      );
      logWarn("websocket.upgrade_rejected", {
        request_id: current.request_id,
        provider_id: target.provider.id,
        credential_id: target.credential.id,
        status: response.status,
        attempts: result.attempts,
      });
      await this.closeAll(
        1011,
        "upstream websocket upgrade failed",
        "upstream_upgrade_failed",
      );
      return;
    }

    try {
      this.upstream.attach(socket);
    } catch (error) {
      closeSocket(socket, 1011, "upstream websocket acceptance failed");
      await this.health.fail();
      logWarn("websocket.upstream_accept.failed", {
        request_id: current.request_id,
        provider_id: target.provider.id,
        credential_id: target.credential.id,
        error: errorMessage(error),
      });
      await this.closeAll(
        1011,
        "upstream websocket unavailable",
        "upstream_socket_unavailable",
      );
      return;
    }

    const opened = await this.storage.transition(["connecting"], (state) => ({
      ...state,
      phase: "open",
      active_response: true,
      response_outcome_recorded: false,
    }));
    if (!opened) {
      this.upstream.discard(socket);
      return;
    }
    const rewritten = rewriteResponseCreate(
      originalMessage,
      frame,
      target.upstreamModel,
    );
    if (!safeSend(socket, rewritten)) {
      await this.health.fail();
      await this.closeAll(
        1011,
        "upstream websocket unavailable",
        "upstream_socket_unavailable",
      );
      return;
    }
    logInfo("websocket.connected", {
      request_id: opened.next.request_id,
      provider_id: target.provider.id,
      credential_id: target.credential.id,
      model: bounded(target.upstreamModel, 160),
      model_rewritten: frame.model !== target.upstreamModel,
      attempts: result.attempts,
    });
  }

  private async processFirstFrame(
    message: WebSocketMessage,
    receivedAt: number,
  ): Promise<void> {
    if (typeof message !== "string") {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          "The first WebSocket message must be a response.create JSON text frame",
          "invalid_websocket_first_frame",
        ),
      );
      await this.closeAll(
        1008,
        "invalid first websocket frame",
        "invalid_first_frame",
      );
      return;
    }
    const parsedFrame = clientFrame(message);
    if (parsedFrame.kind !== "response_create") {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          "The first WebSocket message must contain response.create and a model",
          "invalid_websocket_first_frame",
        ),
      );
      await this.closeAll(
        1008,
        "invalid first websocket frame",
        "invalid_first_frame",
      );
      return;
    }

    const claimed = await this.storage.transition(
      ["awaiting_first_frame"],
      (latest) => ({
        ...latest,
        phase: "routing",
      }),
    );
    if (!claimed) {
      return;
    }
    const meter = await this.usage.start(
      claimed.next.request_id,
      parsedFrame.frame.model,
      receivedAt,
    );
    await this.storage.scheduleAlarm();
    if ((await this.storage.loadSession())?.phase !== "routing") {
      return;
    }

    const routingContext = await this.currentRoutingContext(claimed.next);
    if (
      !routingContext ||
      (await this.storage.loadSession())?.phase !== "routing"
    ) {
      return;
    }
    const frame = parsedFrame.frame;
    await this.usage.select(meter, routingContext);
    const contextManagement = frameUsesContextManagement(frame, claimed.next);
    const sessionId = claimed.next.header_session_id ?? frame.sessionId;
    if (
      contextManagement &&
      !contextManagementSessionMatches(frame.payload, sessionId)
    ) {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          "Context management requires consistent session ids",
          "invalid_context_management_request",
        ),
      );
      await this.closeAll(
        1008,
        "missing context session",
        "invalid_context_management_request",
      );
      return;
    }
    const route = resolveModelRoute(
      routingContext.config,
      routingContext.client,
      frame.model,
      {
        endpoint: "responses",
        transport: "websocket",
        requiredCapabilities: [
          "supports_websocket",
          ...(contextManagement
            ? ["supports_context_management" as const]
            : []),
        ],
      },
    );
    if (route.targets.length === 0) {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          `Model ${frame.model} is not available for this API key`,
          "model_not_found",
        ),
      );
      await this.closeAll(1008, "model unavailable", "model_unavailable");
      return;
    }

    const selection = await selectAvailableProviderWithDetails(
      this.env,
      route,
      sessionId
        ? {
            contextManagement,
            session: {
              clientId: routingContext.client.id,
              sessionId,
            },
          }
        : {},
    );
    if (selection.affinity?.status === "failed") {
      logWarn("websocket.affinity.failed", {
        request_id: claimed.next.request_id,
        error: selection.affinity.error,
      });
    }
    if (!selection.target) {
      safeSend(
        this.clientSocket(),
        unavailableTargetError(selection, frame.model),
      );
      await this.closeAll(
        1013,
        "no healthy upstream provider",
        "no_healthy_upstream",
      );
      return;
    }
    if (
      selection.affinity?.context_management &&
      !contextManagementSessionMatches(frame.payload, sessionId)
    ) {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          "Context management session ids must match",
          "invalid_context_management_request",
        ),
      );
      await this.closeAll(
        1008,
        "inconsistent context session",
        "invalid_context_management_request",
      );
      return;
    }
    await this.usage.select(meter, routingContext, selection.target);
    await this.connectUpstream(
      message,
      frame,
      route,
      selection.target,
      sessionId,
      contextManagement || selection.affinity?.context_management === true,
      routingContext.config,
    );
  }

  private async processOpenMessage(
    state: StoredWebSocketSession,
    message: WebSocketMessage,
    receivedAt: number,
  ): Promise<void> {
    if (typeof message === "string") {
      const parsedFrame = clientFrame(message);
      if (parsedFrame.kind === "invalid_response_create") {
        safeSend(
          this.clientSocket(),
          gatewayErrorEvent(
            400,
            "Every response.create frame must contain a non-empty model string",
            "invalid_websocket_response_create",
          ),
        );
        await this.closeAll(
          1008,
          "invalid response.create frame",
          "invalid_response_create",
        );
        return;
      }
      if (parsedFrame.kind === "response_create") {
        const meter = await this.usage.start(
          state.request_id,
          parsedFrame.frame.model,
          receivedAt,
        );
        const routingContext = await this.currentRoutingContext(state);
        if (!routingContext) {
          return;
        }
        const current = await this.storage.loadSession();
        if (current?.phase !== "open") {
          return;
        }
        const frame = parsedFrame.frame;
        await this.usage.select(meter, routingContext);
        const contextManagement = frameUsesContextManagement(frame, current);
        const route = resolveModelRoute(
          routingContext.config,
          routingContext.client,
          frame.model,
          {
            endpoint: "responses",
            transport: "websocket",
            requiredCapabilities: [
              "supports_websocket",
              ...(contextManagement
                ? ["supports_context_management" as const]
                : []),
            ],
          },
        );
        const boundSessionId =
          current.header_session_id ?? current.current_session_id;
        const sessionId = boundSessionId ?? frame.sessionId;
        const targetValidation = await validateCurrentTarget(
          this.env,
          current,
          route,
          sessionId,
          routingContext.client,
          contextManagement,
        );
        if (route.targets.length === 0 || !targetValidation.valid) {
          safeSend(
            this.clientSocket(),
            gatewayErrorEvent(
              503,
              "The bound upstream provider or key is no longer available; reconnect the WebSocket",
              "websocket_reconnect_required",
            ),
          );
          await this.closeAll(
            1012,
            "upstream binding changed",
            "binding_changed",
          );
          return;
        }
        const activeContextManagement =
          contextManagement ||
          current.context_management === true ||
          targetValidation.contextManagement;
        if (
          activeContextManagement &&
          !contextSessionIdsMatch(frame, current, sessionId)
        ) {
          safeSend(
            this.clientSocket(),
            gatewayErrorEvent(
              400,
              "Context management session ids must match",
              "invalid_context_management_request",
            ),
          );
          await this.closeAll(
            1008,
            "inconsistent context session",
            "invalid_context_management_request",
          );
          return;
        }
        const activated = await this.storage.transition(["open"], (latest) => ({
          ...latest,
          ...(sessionId ? { current_session_id: sessionId } : {}),
          ...(activeContextManagement ? { context_management: true } : {}),
          active_response: true,
          response_outcome_recorded: false,
        }));
        const selectedTarget = targetFromRoute(route, current);
        if (!selectedTarget) {
          safeSend(
            this.clientSocket(),
            gatewayErrorEvent(
              503,
              "The bound upstream provider or key is no longer available; reconnect the WebSocket",
              "websocket_reconnect_required",
            ),
          );
          await this.closeAll(
            1012,
            "upstream binding changed",
            "binding_changed",
          );
          return;
        }
        await this.usage.select(meter, routingContext, selectedTarget);
        const upstream = this.upstream.socket;
        if (
          !activated ||
          !safeSend(
            upstream,
            rewriteResponseCreate(message, frame, selectedTarget.upstreamModel),
          )
        ) {
          await this.health.fail();
          await this.closeAll(
            1011,
            "upstream websocket unavailable",
            "upstream_socket_unavailable",
          );
        }
        return;
      }
    }

    if (!safeSend(this.upstream.socket, message)) {
      await this.health.fail();
      await this.closeAll(
        1011,
        "upstream websocket unavailable",
        "upstream_socket_unavailable",
      );
    }
  }

  private async processClientMessage(
    message: WebSocketMessage,
    receivedAt: number,
  ): Promise<void> {
    const state = await this.storage.loadSession();
    if (!state || state.phase === "closed") {
      return;
    }
    if (state.phase === "awaiting_first_frame") {
      await this.processFirstFrame(message, receivedAt);
      return;
    }
    if (state.phase === "open") {
      await this.processOpenMessage(state, message, receivedAt);
    }
  }

  private enqueueClientMessage(message: WebSocketMessage): Promise<void> {
    const receivedAt = Date.now();
    const bytes = messageBytes(message);
    this.pendingClientBytes += bytes;
    if (this.pendingClientBytes > MAX_PENDING_WEBSOCKET_BYTES) {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          413,
          "Pending WebSocket messages exceed 32 MiB",
          "websocket_queue_too_large",
        ),
      );
      return this.closeAll(
        1009,
        "pending websocket messages too large",
        "client_queue_too_large",
      );
    }

    const processing = this.clientMessages.then(async () => {
      this.pendingClientBytes -= bytes;
      await this.processClientMessage(message, receivedAt);
    });
    this.clientMessages = processing.catch(async (error) => {
      logError("websocket.client_message.failed", {
        error: errorMessage(error),
      });
      await this.closeAll(
        1011,
        "client message processing failed",
        "client_message_processing_failed",
      );
    });
    return this.clientMessages;
  }

  override webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    const role = this.socketRole(socket);
    if (role === "client") {
      this.ctx.waitUntil(this.enqueueClientMessage(message));
      return;
    }
    this.ctx.waitUntil(
      this.closeAll(1011, "unknown websocket peer", "unknown_socket_role"),
    );
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const role = this.socketRole(socket);
    await this.closeAll(
      code,
      reason || `${role ?? "unknown"} websocket closed`,
      role === "client"
        ? code === 1000
          ? "client_closed"
          : "client_closed_abnormally"
        : "unknown_socket_closed",
    );
  }

  override async webSocketError(
    socket: WebSocket,
    error: unknown,
  ): Promise<void> {
    const role = this.socketRole(socket);
    const state = await this.storage.loadSession();
    logWarn("websocket.socket_error", {
      request_id: state?.request_id,
      role,
      error: errorMessage(error),
    });
    await this.closeAll(
      1011,
      `${role ?? "unknown"} websocket error`,
      role === "client" ? "client_socket_error" : "unknown_socket_error",
    );
  }
}
