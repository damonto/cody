import { recordKeyFailure, healthFailureScope } from "../health/health.ts";
import { upstreamUrl } from "../http/http.ts";
import { fetchWithConfiguredRetries } from "../http/proxy.ts";
import { createUpstreamFetch } from "../transport/index.ts";
import { logError, errorMessage } from "../../shared/log.ts";
import type { ModelServiceTarget } from "../routing/routing.ts";
import type { StoredWebSocketSession } from "./storage.ts";
import {
  closeSocket,
  normalizeMessage,
  type WebSocketMessage,
} from "./websocket-protocol.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
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
    private readonly env: Env,
    private readonly context: Pick<DurableObjectState, "waitUntil">,
    private readonly handlers: UpstreamHandlers,
  ) {}

  get socket(): WebSocket | undefined {
    return this.connection;
  }

  async connect(
    state: StoredWebSocketSession,
    target: ModelServiceTarget,
  ): ReturnType<typeof fetchWithConfiguredRetries> {
    const controller = new AbortController();
    this.controller = controller;
    const headers = new Headers(state.forwarded_headers);
    headers.set("authorization", `Bearer ${target.key.api_key}`);
    headers.set("upgrade", "websocket");
    try {
      return await fetchWithConfiguredRetries(
        () =>
          new Request(
            upstreamUrl(target.service, "responses", state.incoming_search),
            {
              method: "GET",
              headers,
              redirect: "manual",
              signal: controller.signal,
            },
          ),
        target.service.retry,
        {
          send: createUpstreamFetch(target.service, target.key),
          wait: (delayMs) => abortableDelay(delayMs, controller.signal),
          attemptTimeoutMs: HANDSHAKE_TIMEOUT_MS,
          onResponse: async (response) => {
            if (healthFailureScope(response.status, "openai") === "key") {
              await recordKeyFailure(
                this.env,
                target.service.id,
                target.key.id,
                state.request_id,
              );
            }
          },
        },
      );
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
    event: "message" | "close" | "error",
    operation: () => Promise<void>,
  ): void {
    const processing = this.events.then(operation);
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
      this.enqueue("message", async () => {
        const message = await normalizeMessage(event.data);
        if (message !== undefined) {
          await this.handlers.message(message, receivedAt);
        }
      });
    });
    socket.addEventListener("close", (event) => {
      this.enqueue("close", () => this.handlers.close(event));
    });
    socket.addEventListener("error", () => {
      this.enqueue("error", () => this.handlers.error());
    });

    // Cloudflare only supports hibernation when the Durable Object is the
    // WebSocket server. Outgoing WebSockets use the standard API and keep the
    // object active while connected.
    socket.accept({ allowHalfOpen: true });
    this.connection = socket;
  }
}
