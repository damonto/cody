import { ProviderType } from "../../config/values.ts";
import { ProviderTransport } from "../../providers/transport-values.ts";
import { ApiProtocol } from "../protocol-values.ts";
import { HealthFailureScope } from "../health/values.ts";

import type { GatewayConfig } from "../../config/types.ts";
import {
  codexUsageLimit,
  type CodexUsageLimit,
} from "../../providers/codex/limits.ts";
import { prepareProviderRequest } from "../../providers/index.ts";
import { errorMessage, logError } from "../../shared/log.ts";
import {
  healthFailureScope,
  recordCredentialFailure,
} from "../health/health.ts";
import {
  fetchWithConfiguredRetries,
  type FetchWithRetriesResult,
} from "../http/proxy.ts";
import type { ProxyFailure } from "../proxies/errors.ts";
import type { ModelProviderTarget } from "../routing/routing.ts";
import type { StoredWebSocketSession } from "./storage.ts";
import {
  closeSocket,
  normalizeMessage,
  type WebSocketMessage,
} from "./websocket-protocol.ts";
import type { Bindings } from "../../platform/bindings.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;

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

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Owns the outgoing connection, cancellation, and ordered upstream events. */
export class UpstreamWebSocket {
  private controller: AbortController | undefined;
  private connection: WebSocket | undefined;
  private events = Promise.resolve();

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
          wait: (delayMs) => abortableDelay(delayMs, controller.signal),
          attemptTimeoutMs: HANDSHAKE_TIMEOUT_MS,
          ...(target.provider.type === ProviderType.Codex
            ? {
                isTerminal: async (response: Response) => {
                  usageLimit = await codexUsageLimit(response);
                  return usageLimit !== undefined;
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

  close(code: number, reason: string): void {
    this.controller?.abort();
    this.controller = undefined;
    closeSocket(this.connection, code, reason);
    this.connection = undefined;
  }

  discard(socket: WebSocket): void {
    if (this.connection === socket) this.connection = undefined;
    closeSocket(socket, 1000, "client disconnected");
  }

  private enqueue(
    socket: WebSocket,
    event: "message" | "close" | "error",
    operation: () => Promise<void>,
  ): void {
    // A socket replaced by an account switch no longer reaches the handlers,
    // including events it queued before the switch.
    if (this.connection !== socket) return;
    const processing = this.events.then(() =>
      this.connection === socket ? operation() : undefined,
    );
    this.events = processing.catch(async (error) => {
      logError("websocket.upstream_event.failed", {
        upstream_event: event,
        error: errorMessage(error),
      });
      await this.handlers.failure();
    });
    this.context.waitUntil(this.events);
  }

  attach(socket: WebSocket): void {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const receivedAt = Date.now();
      this.enqueue(socket, "message", async () => {
        const message = await normalizeMessage(event.data);
        if (message !== undefined) {
          await this.handlers.message(message, receivedAt);
        }
      });
    });
    socket.addEventListener("close", (event) => {
      this.enqueue(socket, "close", () => this.handlers.close(event));
    });
    socket.addEventListener("error", () => {
      this.enqueue(socket, "error", () => this.handlers.error());
    });

    // Cloudflare only supports hibernation when the Durable Object is the
    // WebSocket server. Outgoing WebSockets use the standard API and keep the
    // object active while connected.
    socket.accept({ allowHalfOpen: true });
    this.connection = socket;
  }
}
