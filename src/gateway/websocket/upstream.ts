import {
  MAX_WEBSOCKET_BUFFER_BYTES,
  MAX_WEBSOCKET_BUFFER_MESSAGES,
} from "../../shared/payload-limits.ts";
import { ProviderType } from "../../config/values.ts";
import { ProviderTransport } from "../../providers/transport-values.ts";
import { ApiProtocol } from "../protocol-values.ts";
import { HealthFailureScope } from "../health/values.ts";

import type { GatewayConfig } from "../../config/types.ts";
import type { CodexUsageLimit } from "../../providers/codex/limits.ts";
import { inspectCodexResponse } from "../../providers/codex/inspect.ts";
import { prepareProviderRequest } from "../../providers/index.ts";
import { errorMessage, logError } from "../../shared/log.ts";
import {
  healthFailureScope,
  recordCredentialFailure,
} from "../health/health.ts";
import {
  fetchWithConfiguredRetries,
  type FetchWithRetriesResult,
} from "../http/upstream-retry.ts";
import type { ProxyFailure } from "../proxies/errors.ts";
import type { ModelProviderTarget } from "../routing/routing.ts";
import type { StoredWebSocketSession } from "./storage.ts";
import {
  closeSocket,
  messageBytes,
  normalizeMessage,
  type WebSocketMessage,
} from "./websocket-protocol.ts";
import type { Bindings } from "../../platform/bindings.ts";
import { abortableDelay } from "../../shared/abort.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;

type UpstreamEvent = { socket: WebSocket; bytes: number } & (
  | { type: "message"; data: unknown; receivedAt: number }
  | { type: "close"; event: CloseEvent }
  | { type: "error" | "failure" }
);

interface WebSocketConnectResult extends FetchWithRetriesResult {
  readonly proxyError?: ProxyFailure | undefined;
  /** Set when a Codex account rejected the upgrade for exhausted quota. */
  readonly usageLimit?: CodexUsageLimit | undefined;
}

interface UpstreamHandlers {
  message: (message: WebSocketMessage, receivedAt: number) => Promise<void>;
  close: (event: CloseEvent) => Promise<void>;
  error: () => Promise<void>;
  failure: () => Promise<void>;
}

/** Owns the outgoing connection, cancellation, and ordered upstream events. */
export class UpstreamWebSocket {
  private controller: AbortController | undefined;
  private connection: WebSocket | undefined;
  private readonly events: UpstreamEvent[] = [];
  private pendingBytes = 0;
  private active: UpstreamEvent | undefined;
  private processing = false;
  private detach: (() => void) | undefined;
  private observeMessage:
    ((value: unknown, receivedAt: number) => void) | undefined;

  constructor(
    private readonly env: Bindings,
    private readonly context: Pick<DurableObjectState, "waitUntil">,
    private readonly handlers: UpstreamHandlers,
  ) {}

  get socket(): WebSocket | undefined {
    return this.connection;
  }

  async connect(
    state: StoredWebSocketSession,
    target: ModelProviderTarget,
    config: GatewayConfig,
  ): Promise<WebSocketConnectResult> {
    const controller = new AbortController();
    this.controller = controller;
    let usageLimit: CodexUsageLimit | undefined;
    try {
      const prepared = await prepareProviderRequest(
        target.provider,
        target.credential,
        {
          request: new Request(
            `https://gateway.invalid/responses${state.incoming_search}`,
            { headers: state.forwarded_headers, signal: controller.signal },
          ),
          endpoint: "responses",
          transport: ProviderTransport.Websocket,
          protocol: ApiProtocol.Openai,
        },
        {
          config,
          env: this.env,
          context: this.context,
          requestId: state.request_id,
        },
      );
      if (prepared.kind === "local")
        throw new Error("Unexpected local provider response");
      const result = await fetchWithConfiguredRetries(
        () =>
          new Request(prepared.url, {
            method: "GET",
            headers: prepared.headers,
            redirect: "manual",
            signal: controller.signal,
          }),
        target.provider.retry,
        {
          send: prepared.send,
          recoverUnauthorized: prepared.recoverUnauthorized,
          observeResponse: prepared.observeResponse,
          wait: (delayMs) => abortableDelay(delayMs, controller.signal),
          attemptTimeoutMs: HANDSHAKE_TIMEOUT_MS,
          ...(target.provider.type === ProviderType.Codex
            ? {
                inspectResponse: async (
                  response: Response,
                  signal: AbortSignal,
                  timeoutMs: number | undefined,
                ) => {
                  const {
                    response: inspectedResponse,
                    usageLimit: limit,
                    ...retry
                  } = await inspectCodexResponse(response, {
                    signal,
                    timeoutMs,
                  });
                  usageLimit = limit;
                  return {
                    response: inspectedResponse,
                    terminal: limit !== undefined,
                    retry,
                  };
                },
              }
            : {}),
          onResponse: async (response) => {
            if (
              healthFailureScope(
                response.status,
                ApiProtocol.Openai,
                target.provider.type,
              ) === HealthFailureScope.Credential
            ) {
              await recordCredentialFailure(
                this.env,
                target.provider.id,
                target.credential.id,
                state.request_id,
              );
            }
          },
        },
      );
      if (result.response?.status === 101)
        this.observeMessage = prepared.observeWebSocketEvent;
      return {
        ...result,
        proxyError: result.response
          ? undefined
          : prepared.proxyFailure(result.error),
        usageLimit: result.response ? usageLimit : undefined,
      };
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  observeEvent(value: unknown, receivedAt: number): void {
    this.observeMessage?.(value, receivedAt);
  }

  close(code: number, reason: string): void {
    this.controller?.abort();
    this.controller = undefined;
    this.clearEvents();
    closeSocket(this.connection, code, reason);
    this.connection = undefined;
    this.observeMessage = undefined;
  }

  discard(socket: WebSocket): void {
    if (this.connection === socket) {
      this.clearEvents();
      this.connection = undefined;
      this.observeMessage = undefined;
    }
    closeSocket(socket, 1000, "client disconnected");
  }

  private clearEvents(): void {
    this.detach?.();
    this.detach = undefined;
    this.events.length = 0;
    this.pendingBytes = 0;
  }

  private enqueue(event: UpstreamEvent): void {
    // A socket replaced by an account switch no longer reaches the handlers,
    // including events it queued before the switch.
    if (this.connection !== event.socket || !this.detach) return;
    if (
      event.type === "message" &&
      (this.events.length + (this.active ? 1 : 0) >=
        MAX_WEBSOCKET_BUFFER_MESSAGES ||
        this.pendingBytes + (this.active?.bytes ?? 0) + event.bytes >
          MAX_WEBSOCKET_BUFFER_BYTES)
    ) {
      this.clearEvents();
      closeSocket(event.socket, 1013, "upstream buffer limit exceeded");
      this.events.push({ socket: event.socket, type: "failure", bytes: 0 });
    } else {
      this.events.push(event);
      this.pendingBytes += event.bytes;
      if (event.type !== "message") {
        // Reserve one terminal control event even when the message budget is full.
        // Drain earlier frames in order, but accept no later events.
        this.detach();
        this.detach = undefined;
      }
    }
    if (this.processing) return;
    this.processing = true;
    this.context.waitUntil(this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.events.length) {
        const event = this.events.shift()!;
        this.pendingBytes -= event.bytes;
        this.active = event;
        try {
          if (this.connection !== event.socket) continue;
          switch (event.type) {
            case "message": {
              const message = await normalizeMessage(event.data);
              if (message !== undefined && this.connection === event.socket)
                await this.handlers.message(message, event.receivedAt);
              break;
            }
            case "close":
              await this.handlers.close(event.event);
              break;
            case "error":
              await this.handlers.error();
              break;
            case "failure":
              await this.handlers.failure();
              break;
          }
        } catch (error) {
          if (this.connection !== event.socket) continue;
          this.clearEvents();
          closeSocket(event.socket, 1011, "upstream event processing failed");
          logError("websocket.upstream_event.failed", {
            upstream_event: event.type,
            error: errorMessage(error),
          });
          if (event.type !== "failure") await this.handlers.failure();
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  attach(socket: WebSocket): void {
    if (this.connection === socket) return;
    this.clearEvents();
    closeSocket(this.connection, 1000, "upstream connection replaced");
    this.connection = socket;
    socket.binaryType = "arraybuffer";
    const message = (event: MessageEvent): void => {
      this.enqueue({
        socket,
        type: "message",
        bytes: messageBytes(event.data),
        data: event.data,
        receivedAt: Date.now(),
      });
    };
    const closed = (event: CloseEvent): void => {
      this.enqueue({ socket, type: "close", bytes: 0, event });
    };
    const error = (): void => {
      this.enqueue({ socket, type: "error", bytes: 0 });
    };
    socket.addEventListener("message", message);
    socket.addEventListener("close", closed);
    socket.addEventListener("error", error);
    this.detach = () => {
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", error);
    };

    // Cloudflare only supports hibernation when the Durable Object is the
    // WebSocket server. Outgoing WebSockets use the standard API and keep the
    // object active while connected.
    try {
      socket.accept({ allowHalfOpen: true });
    } catch (error) {
      this.close(1011, "upstream websocket acceptance failed");
      throw error;
    }
  }
}
