import { SessionAffinityStatus } from "../routing/values.ts";

import { RequestOutcome } from "../../telemetry/values.ts";
import { SessionPhase } from "./values.ts";
import { ProviderType } from "../../config/values.ts";
import { ApiProtocol } from "../protocol-values.ts";
import { HealthFailureScope } from "../health/values.ts";
import { ProviderTransport } from "../../providers/transport-values.ts";

import { WebSocketHealth, shouldRecordUpstreamFailure } from "./health.ts";
import {
  contextSessionIdsMatch,
  frameUsesContextManagement,
  targetFromRoute,
  unavailableTargetError,
  validateCurrentTarget,
  type CurrentRoutingContext,
} from "./routing.ts";
import {
  LIVE_PHASES,
  WebSocketStorage,
  type StoredWebSocketSession,
} from "./storage.ts";
import { UpstreamWebSocket } from "./upstream.ts";
import { WebSocketUsage } from "./usage.ts";

import { loadConfig } from "../../config/store.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "../../config/types.ts";
import {
  bounded,
  configureLogging,
  errorMessage,
  logError,
  logInfo,
  logWarn,
} from "../../shared/log.ts";
import { webSocketUsageSink } from "../../telemetry/delivery.ts";
import {
  healthFailureScope,
  recordCredentialQuotaCooldown,
} from "../health/health.ts";
import {
  findClientApiKeyByDigest,
  forwardableWebSocketHeaders,
} from "../http/http.ts";
import { UpstreamAttemptTimeoutError } from "../http/upstream-retry.ts";
import {
  credentialKey,
  resolveModelRoute,
  selectAvailableProviderWithDetails,
  type ModelProviderTarget,
  type ModelRoute,
  type ProviderSelection,
} from "../routing/routing.ts";
import { contextManagementSessionMatches } from "../sessions/context-management-protocol.ts";
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
  upstreamErrorEvent,
  type ResponseCreateFrame,
  type WebSocketMessage,
} from "./websocket-protocol.ts";
import {
  blockedCodexQuotaResetsAt,
  codexQuotaResetsAt,
  restoreCodexAccount,
} from "../../providers/codex/exhaustion.ts";
import {
  CODEX_QUOTA_CODES,
  codexUsageLimitEvent,
  codexUsageLimitFromError,
  type CodexUsageLimit,
} from "../../providers/codex/limits.ts";
import { retryErrorIsReplayable } from "../http/retry-errors.ts";
import type { RequestMeter } from "../../telemetry/meter.ts";
import type { Bindings } from "../../platform/bindings.ts";
import type {
  WebSocketHandler,
  WebSocketObjectContext,
} from "../../platform/object-context.ts";
import { webSocketUpgradeResponse } from "../../platform/websocket-upgrade.ts";

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

/**
 * The first response.create of a connection, kept while a Codex account that
 * reports exhausted quota can still hand it to another account.
 */
interface FirstFrameAttempt {
  readonly requestId: string;
  readonly message: string;
  readonly frame: ResponseCreateFrame;
  readonly route: ModelRoute;
  readonly sessionId: string | undefined;
  readonly contextManagement: boolean;
  readonly routingContext: CurrentRoutingContext;
  readonly meter: RequestMeter | undefined;
  readonly excluded: Set<string>;
  /** Quota switching cannot leave the provider that accepted the first attempt. */
  lockedProvider: string | undefined;
  switches: number;
  resetConsumed: boolean;
  /** The last exhausted account's error, returned when no account remains. */
  exhausted: string | undefined;
  target: ModelProviderTarget | undefined;
}

/** Looks up a header echoed in a Codex WebSocket error event. */
function eventHeader(
  payload: Record<string, unknown>,
  name: string,
): string | undefined {
  const headers = payload.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name)
      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : undefined;
  return undefined;
}

function requestOutcomeOnClose(code: number, outcome: string) {
  if (outcome.startsWith("client_")) return RequestOutcome.Cancelled;
  return code === 1000 ? RequestOutcome.Incomplete : RequestOutcome.Failed;
}

export class ResponsesWebSocketProxyCore implements WebSocketHandler {
  private pendingClientBytes = 0;
  private clientMessages = Promise.resolve();
  /** Client messages received by this instance, including the first frame. */
  private receivedClientMessages = 0;
  private attempt: FirstFrameAttempt | undefined;
  /** Holds later client frames while the first frame moves to another account. */
  private switching: Promise<void> | undefined;
  private readonly upstream: UpstreamWebSocket;
  private readonly health: WebSocketHealth;
  private readonly storage: WebSocketStorage;
  private readonly usage: WebSocketUsage;

  constructor(
    protected readonly ctx: WebSocketObjectContext,
    protected readonly env: Bindings,
  ) {
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
      this.env.USAGE_OUTBOX
        ? webSocketUsageSink({
            USAGE_OUTBOX: this.env.USAGE_OUTBOX,
            USAGE_QUEUE: this.env.USAGE_QUEUE,
          })
        : undefined,
      this.ctx,
    );
    if (this.env.USAGE_OUTBOX) {
      // Only local storage work runs under the constructor's input gate.
      void this.ctx.blockConcurrencyWhile(async () => {
        await this.storage.recoverUsage();
        this.ctx.waitUntil(this.usage.flush());
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
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
      phase: SessionPhase.AwaitingFirstFrame,
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
    return webSocketUpgradeResponse(pair[0]);
  }

  async alarm(): Promise<void> {
    await this.usage.flush();
    const state = await this.storage.loadSession();
    if (state?.phase !== SessionPhase.AwaitingFirstFrame) {
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
      [SessionPhase.AwaitingFirstFrame],
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
        phase: SessionPhase.Closed,
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
    await this.settleAttempt();
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
    if (state?.phase !== SessionPhase.Open) {
      return;
    }
    const payload =
      typeof message === "string" ? parseObject(message) : undefined;
    const status = payload ? errorStatus(payload) : undefined;
    const usageLimit =
      payload &&
      ((payload.type === "error" && status === 429) ||
        payload.type === "response.failed") &&
      state.selected_provider_type === ProviderType.Codex
        ? codexUsageLimitFromError(payload, (name) =>
            eventHeader(payload, name),
          )
        : undefined;
    const attempt = this.attempt;
    if (
      usageLimit &&
      typeof message === "string" &&
      attempt &&
      (payload?.type !== "response.failed" ||
        retryErrorIsReplayable(payload, "", CODEX_QUOTA_CODES)) &&
      this.receivedClientMessages <= 1
    ) {
      // Nothing but this error has reached the upstream's reply, and the
      // client has sent nothing else, so the first frame can move accounts.
      await this.switchAccount(attempt, message, usageLimit);
      return;
    }
    await this.settleAttempt();
    if (
      usageLimit &&
      state.selected_provider_id &&
      state.selected_credential_id
    ) {
      await recordCredentialQuotaCooldown(
        this.env,
        state.selected_provider_id,
        state.selected_credential_id,
        usageLimit.resets_at,
        state.request_id,
      );
    }
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
        this.usage.finish(meter, RequestOutcome.Success);
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
          payload.type === "response.failed"
            ? RequestOutcome.Failed
            : RequestOutcome.Incomplete,
          status ?? null,
        );
      }
      await this.health.inactive();
      if (usageLimit)
        await this.closeAll(
          1011,
          "selected upstream key is cooling down",
          "usage_limit_reached",
        );
      return;
    }
    if (payload.type === "error") {
      if (meter) {
        this.usage.finish(meter, RequestOutcome.Failed, status ?? null);
      }
      await this.health.inactive();
      // Codex frame status, as above.
      const keyFailure =
        usageLimit !== undefined ||
        (status !== undefined &&
          healthFailureScope(
            status,
            ApiProtocol.Openai,
            state.selected_provider_type,
          ) === HealthFailureScope.Credential);
      await this.closeAll(
        1011,
        keyFailure
          ? "selected upstream key is cooling down"
          : "upstream returned an error",
        usageLimit
          ? "usage_limit_reached"
          : keyFailure
            ? "key_cooling_down"
            : "upstream_error",
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
      state?.phase === SessionPhase.Connecting && upstreamFailed
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

  /** Returns "switch" when the account was exhausted and another may serve the frame. */
  private async connectUpstream(
    attempt: FirstFrameAttempt,
    target: ModelProviderTarget,
    contextManagement: boolean,
  ): Promise<"switch" | undefined> {
    const { frame, sessionId } = attempt;
    const connecting = await this.storage.transition(
      [SessionPhase.Routing],
      (state) => ({
        ...state,
        phase: SessionPhase.Connecting,
        ...(sessionId ? { current_session_id: sessionId } : {}),
        selected_provider_id: target.provider.id,
        selected_provider_type: target.provider.type,
        selected_credential_id: target.credential.id,
        ...(contextManagement ? { context_management: true } : {}),
      }),
    );
    if (!connecting) {
      return;
    }

    const result = await this.upstream.connect(
      connecting.next,
      target,
      attempt.routingContext.config,
    );

    const current = await this.storage.loadSession();
    if (current?.phase !== SessionPhase.Connecting) {
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
      if (result.usageLimit) {
        const error = await upstreamErrorEvent(
          response,
          codexUsageLimitEvent(result.usageLimit.resets_at),
        );
        const routing = await this.storage.transition(
          [SessionPhase.Connecting],
          (state) => ({ ...state, phase: SessionPhase.Routing }),
        );
        if (!routing) return;
        const excluded = await this.excludeAccount(
          attempt,
          result.usageLimit,
          error,
        );
        return excluded ? "switch" : undefined;
      }
      if (
        healthFailureScope(
          response.status,
          ApiProtocol.Openai,
          target.provider.type,
        ) === HealthFailureScope.Provider
      ) {
        await this.health.fail();
      }
      safeSend(this.clientSocket(), await upstreamErrorEvent(response));
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

    const opened = await this.storage.transition(
      [SessionPhase.Connecting],
      (state) => ({
        ...state,
        phase: SessionPhase.Open,
        active_response: true,
        response_outcome_recorded: false,
      }),
    );
    if (!opened) {
      this.upstream.discard(socket);
      return;
    }
    const rewritten = rewriteResponseCreate(
      attempt.message,
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
      ...(attempt.switches > 0 ? { account_switches: attempt.switches } : {}),
    });
    return undefined;
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
      [SessionPhase.AwaitingFirstFrame],
      (latest) => ({
        ...latest,
        phase: SessionPhase.Routing,
      }),
    );
    if (!claimed) {
      return;
    }
    const meter = await this.usage.start(
      claimed.next.request_id,
      parsedFrame.frame,
      receivedAt,
    );
    await this.storage.scheduleAlarm();
    if ((await this.storage.loadSession())?.phase !== SessionPhase.Routing) {
      return;
    }

    const routingContext = await this.currentRoutingContext(claimed.next);
    if (
      !routingContext ||
      (await this.storage.loadSession())?.phase !== SessionPhase.Routing
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
        transport: ProviderTransport.Websocket,
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

    const attempt: FirstFrameAttempt = {
      requestId: claimed.next.request_id,
      message,
      frame,
      route,
      sessionId,
      contextManagement,
      routingContext,
      meter,
      excluded: new Set(),
      lockedProvider: undefined,
      switches: 0,
      resetConsumed: false,
      exhausted: undefined,
      target: undefined,
    };
    this.attempt = attempt;
    await this.routeFirstFrame(attempt);
  }

  /**
   * Selects an account for the first frame and connects. Codex accounts that
   * report exhausted quota before replying are excluded and the frame moves
   * to the next account.
   */
  private async routeFirstFrame(attempt: FirstFrameAttempt): Promise<void> {
    const { frame, routingContext, sessionId } = attempt;
    for (;;) {
      const route = attempt.lockedProvider
        ? {
            ...attempt.route,
            targets: attempt.route.targets.filter(
              (candidate) => candidate.provider.id === attempt.lockedProvider,
            ),
          }
        : attempt.route;
      const selection = await selectAvailableProviderWithDetails(
        this.env,
        route,
        {
          excludedCredentials: attempt.excluded,
          ...(sessionId
            ? {
                contextManagement: attempt.contextManagement,
                session: {
                  clientId: routingContext.client.id,
                  sessionId,
                },
              }
            : {}),
        },
      );
      if (selection.affinity?.status === SessionAffinityStatus.Failed) {
        logWarn("websocket.affinity.failed", {
          request_id: attempt.requestId,
          error: selection.affinity.error,
        });
      }
      const target = selection.target;
      if (!target) {
        if (!attempt.resetConsumed) {
          attempt.resetConsumed = true;
          if (
            await restoreCodexAccount(
              this.env,
              routingContext.config,
              route.targets,
              selection,
              attempt.excluded,
              attempt.exhausted !== undefined,
              attempt.requestId,
            )
          )
            continue;
        }
        await this.rejectUnroutable(attempt, route, selection);
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
      attempt.target = target;
      // A Codex frame may still move accounts; it is metered once it settles.
      if (target.provider.type !== ProviderType.Codex)
        await this.usage.select(attempt.meter, routingContext, target);
      const outcome = await this.connectUpstream(
        attempt,
        target,
        attempt.contextManagement ||
          selection.affinity?.context_management === true,
      );
      if (outcome !== "switch") return;
    }
  }

  private async rejectUnroutable(
    attempt: FirstFrameAttempt,
    route: ModelRoute,
    selection: ProviderSelection,
  ): Promise<void> {
    const status = selection.affinity?.status;
    const resetsAt =
      status === SessionAffinityStatus.Blocked
        ? blockedCodexQuotaResetsAt(selection)
        : status === SessionAffinityStatus.Forbidden ||
            status === SessionAffinityStatus.Failed
          ? undefined
          : codexQuotaResetsAt(route.targets, selection, attempt.excluded);
    const exhausted =
      attempt.exhausted ??
      (resetsAt === undefined ? undefined : codexUsageLimitEvent(resetsAt));
    safeSend(
      this.clientSocket(),
      exhausted ?? unavailableTargetError(selection, attempt.frame.model),
    );
    await this.closeAll(
      1013,
      exhausted ? "codex usage limit reached" : "no healthy upstream provider",
      exhausted ? "usage_limit_reached" : "no_healthy_upstream",
    );
  }

  /** Cools an exhausted Codex account until its reset and keeps it out of this frame's selection. */
  private async excludeAccount(
    attempt: FirstFrameAttempt,
    limit: CodexUsageLimit,
    error: string,
  ): Promise<boolean> {
    const target = attempt.target;
    if (!target) return false;
    // Awaited: the next selection must already see this account cooling.
    const persisted = await recordCredentialQuotaCooldown(
      this.env,
      target.provider.id,
      target.credential.id,
      limit.resets_at,
      attempt.requestId,
    );
    if (!persisted) {
      await this.settleAttempt();
      safeSend(this.clientSocket(), error);
      await this.closeAll(
        1013,
        "quota coordination unavailable",
        "codex_quota_write_failed",
      );
      return false;
    }
    attempt.lockedProvider = target.provider.id;
    attempt.excluded.add(
      credentialKey(target.provider.id, target.credential.id),
    );
    attempt.switches += 1;
    attempt.exhausted = error;
    attempt.target = undefined;
    logWarn("websocket.codex_account_exhausted", {
      request_id: attempt.requestId,
      provider_id: target.provider.id,
      credential_id: target.credential.id,
      code: limit.code,
      resets_at: limit.resets_at,
    });
    return true;
  }

  /** Drops the exhausted upstream and resends the first frame elsewhere. */
  private async switchAccount(
    attempt: FirstFrameAttempt,
    error: string,
    limit: CodexUsageLimit,
  ): Promise<void> {
    let settle = (): void => {};
    this.switching = new Promise((resolve) => {
      settle = resolve;
    });
    try {
      this.upstream.close(1000, "codex account exhausted");
      const routing = await this.storage.transition(
        [SessionPhase.Open],
        (state) => ({
          ...state,
          phase: SessionPhase.Routing,
          active_response: false,
          response_outcome_recorded: false,
        }),
      );
      if (!routing) return;
      if (await this.excludeAccount(attempt, limit, error))
        await this.routeFirstFrame(attempt);
    } finally {
      this.switching = undefined;
      settle();
    }
  }

  /** Ends the first frame's switch window and meters its final account. */
  private async settleAttempt(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = undefined;
    if (attempt.target?.provider.type === ProviderType.Codex)
      await this.usage.select(
        attempt.meter,
        attempt.routingContext,
        attempt.target,
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
          parsedFrame.frame,
          receivedAt,
        );
        const routingContext = await this.currentRoutingContext(state);
        if (!routingContext) {
          return;
        }
        const current = await this.storage.loadSession();
        if (current?.phase !== SessionPhase.Open) {
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
            transport: ProviderTransport.Websocket,
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
        const activated = await this.storage.transition(
          [SessionPhase.Open],
          (latest) => ({
            ...latest,
            ...(sessionId ? { current_session_id: sessionId } : {}),
            ...(activeContextManagement ? { context_management: true } : {}),
            active_response: true,
            response_outcome_recorded: false,
          }),
        );
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
    if (!state || state.phase === SessionPhase.Closed) {
      return;
    }
    if (state.phase === SessionPhase.AwaitingFirstFrame) {
      await this.processFirstFrame(message, receivedAt);
      return;
    }
    if (state.phase === SessionPhase.Open) {
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

    this.receivedClientMessages += 1;
    const processing = this.clientMessages.then(async () => {
      this.pendingClientBytes -= bytes;
      while (this.switching) await this.switching;
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

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const role = this.socketRole(socket);
    if (role === "client") {
      this.ctx.waitUntil(this.enqueueClientMessage(message));
      return;
    }
    this.ctx.waitUntil(
      this.closeAll(1011, "unknown websocket peer", "unknown_socket_role"),
    );
  }

  async webSocketClose(
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

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
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
