/**
 * Runtime-neutral subset of the Durable Object state API used by the
 * coordination objects. Cloudflare's `DurableObjectState` satisfies it
 * structurally; the standard backend implements it over Redis.
 */
export interface ObjectListOptions {
  readonly prefix?: string;
  readonly limit?: number;
  readonly startAfter?: string;
}

export interface ObjectStorageReader {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  list<T = unknown>(options?: ObjectListOptions): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
}

export interface ObjectTransaction extends ObjectStorageReader {
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface ObjectStorage extends ObjectTransaction {
  transaction<T>(
    closure: (transaction: ObjectTransaction) => Promise<T>,
  ): Promise<T>;
  deleteAll(): Promise<void>;
}

export interface ObjectContext {
  readonly storage: ObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/** Objects that want to be woken at a scheduled time implement `alarm()`. */
export interface AlarmHandler {
  alarm(): Promise<void>;
}

/**
 * Accepted server-side WebSockets for objects that terminate client
 * connections. Cloudflare's hibernation API satisfies it; the Node runtime
 * dispatches socket events to the object's `webSocket*` handlers.
 */
export interface WebSocketObjectContext extends ObjectContext {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(socket: WebSocket): string[];
}

export interface WebSocketHandler {
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void;
  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  webSocketError(socket: WebSocket, error: unknown): Promise<void>;
}
