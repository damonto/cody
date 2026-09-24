/**
 * Responses WebSocket proxy objects for the native Node server. Each client
 * connection gets its own in-process object, exactly like the per-connection
 * Durable Object on Cloudflare. Usage checkpoints and terminal records are
 * journaled in SQL before local storage acknowledges them. Maintenance closes
 * pending usage records if the process exits before a terminal event arrives.
 */
import { ResponsesWebSocketProxyCore } from "../../gateway/websocket/responses-websocket-proxy.ts";
import type {
  Bindings,
  ObjectId,
  WebSocketProxyNamespace,
  WebSocketProxyObject,
} from "../bindings.ts";
import type {
  AlarmHandler,
  WebSocketHandler,
  WebSocketObjectContext,
} from "../object-context.ts";
import {
  AlarmState,
  BackedObjectStorage,
  MemoryObjectBackend,
  runAlarmHandler,
  type ObjectChange,
} from "./objects.ts";
import { durableUsageSink } from "../../telemetry/delivery.ts";
import { parseUsageEvent } from "../../telemetry/schema.ts";
import type { BackgroundTasks } from "./tasks.ts";

const WEBSOCKET_CLOSED = 3;

/** Persist checkpoints and terminal records before acknowledging a local write. */
class WebSocketJournalBackend extends MemoryObjectBackend {
  constructor(private readonly env: Bindings) {
    super();
  }

  override async commit(
    namespace: string,
    name: string,
    change: ObjectChange,
  ): Promise<void> {
    for (const [key, value] of change.puts) {
      if (!key.startsWith("usage:") && !key.startsWith("usage-outbox:"))
        continue;
      const event = parseUsageEvent(JSON.parse(value));
      if (event && this.env.USAGE_OUTBOX) {
        await durableUsageSink(
          { USAGE_OUTBOX: this.env.USAGE_OUTBOX },
          event.request_id,
        ).send(event);
      }
    }
    await super.commit(namespace, name, change);
  }
}

class LocalWebSocketContext implements WebSocketObjectContext {
  readonly storage: BackedObjectStorage;
  private handler: (WebSocketHandler & AlarmHandler) | undefined;
  private readonly sockets = new Map<WebSocket, string[]>();
  private readonly initializing: Promise<unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alarms: Promise<void> = Promise.resolve();

  constructor(
    private readonly tasks: BackgroundTasks,
    env: Bindings,
  ) {
    const backend = new WebSocketJournalBackend(env);
    this.storage = new BackedObjectStorage(
      backend,
      "websocket",
      "connection",
      new AlarmState(backend, "websocket", "connection", (at) =>
        this.schedule(at),
      ),
    );
  }

  attach(handler: WebSocketHandler & AlarmHandler): void {
    this.handler = handler;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.tasks.track(promise);
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const task = callback();
    this.initializing.push(task);
    void task.catch(() => undefined);
    return task;
  }

  async ready(): Promise<void> {
    while (this.initializing.length > 0) {
      await Promise.all(this.initializing.splice(0));
    }
  }

  acceptWebSocket(socket: WebSocket, tags: string[] = []): void {
    socket.accept({ allowHalfOpen: true });
    this.sockets.set(socket, [...tags]);
    socket.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === "string" || data instanceof ArrayBuffer) {
        this.handler?.webSocketMessage(socket, data);
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      const handler = this.handler;
      if (handler) {
        this.tasks.track(
          handler.webSocketClose(
            socket,
            event.code,
            event.reason,
            event.wasClean,
          ),
        );
      }
    });
    socket.addEventListener("error", (event: Event) => {
      const handler = this.handler;
      if (handler) {
        this.tasks.track(
          handler.webSocketError(socket, Reflect.get(event, "error") ?? event),
        );
      }
    });
  }

  getWebSockets(tag?: string): WebSocket[] {
    return [...this.sockets]
      .filter(
        ([socket, tags]) =>
          socket.readyState !== WEBSOCKET_CLOSED &&
          (tag === undefined || tags.includes(tag)),
      )
      .map(([socket]) => socket);
  }

  getTags(socket: WebSocket): string[] {
    return [...(this.sockets.get(socket) ?? [])];
  }

  private schedule(at: number | null): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (at === null) return;
    this.timer = setTimeout(() => this.fire(), Math.max(0, at - Date.now()));
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    const handler = this.handler;
    if (!handler) return;
    this.alarms = this.alarms.then(() =>
      runAlarmHandler(this.storage, handler, () => Date.now()),
    );
    this.tasks.track(this.alarms);
  }
}

class LocalObjectId implements ObjectId {
  constructor(private readonly id: string) {}
  toString(): string {
    return this.id;
  }
}

export class LocalWebSocketProxyNamespace implements WebSocketProxyNamespace {
  constructor(
    private readonly bindings: () => Bindings,
    private readonly tasks: BackgroundTasks,
  ) {}

  newUniqueId(): ObjectId {
    return new LocalObjectId(crypto.randomUUID());
  }

  get(_id: ObjectId): WebSocketProxyObject {
    return {
      fetch: async (request: Request) => {
        const context = new LocalWebSocketContext(this.tasks, this.bindings());
        const proxy = new ResponsesWebSocketProxyCore(context, this.bindings());
        context.attach(proxy);
        await context.ready();
        return proxy.fetch(request);
      },
    };
  }
}
