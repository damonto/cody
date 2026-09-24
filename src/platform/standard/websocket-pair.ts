/**
 * `WebSocketPair` for standard runtimes. Two linked in-memory sockets expose
 * the subset of the Workers WebSocket API this codebase uses, so the
 * Responses WebSocket proxy and the SOCKS WebSocket transport run unchanged.
 * Network sockets are bridged to a pair end by the Node server and by the
 * upstream WebSocket client.
 */
import { Buffer } from "node:buffer";
import {
  MAX_WEBSOCKET_BUFFER_BYTES,
  MAX_WEBSOCKET_BUFFER_MESSAGES,
} from "./websocket-limits.ts";

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

interface AcceptOptions {
  readonly allowHalfOpen?: boolean;
}

function copyBinary(message: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class PairedWebSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  readonly url: string | null = null;
  readonly protocol = "";
  readonly extensions = "";
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  peer: PairedWebSocket | undefined;
  private accepted = false;
  private allowHalfOpen = false;
  private sentClose = false;
  private receivedClose = false;
  private attachment: unknown = null;
  private readonly queued: Event[] = [];
  private queuedBytes = 0;
  private delivering = false;

  get readyState(): number {
    if (this.sentClose && this.receivedClose) return CLOSED;
    return this.sentClose || this.receivedClose ? CLOSING : OPEN;
  }

  accept(options: AcceptOptions = {}): void {
    if (this.accepted) return;
    this.accepted = true;
    this.allowHalfOpen = options.allowHalfOpen ?? false;
    this.deliver();
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.sentClose) {
      throw new TypeError("WebSocket send() after close");
    }
    const size =
      typeof message === "string"
        ? Buffer.byteLength(message)
        : message.byteLength;
    if (!this.peer?.reserve(size)) return;
    this.peer.enqueue(
      new MessageEvent("message", {
        data: typeof message === "string" ? message : copyBinary(message),
      }),
    );
  }

  close(code?: number, reason?: string): void {
    if (this.sentClose) return;
    this.sentClose = true;
    this.peer?.receiveClose(code ?? 1005, reason ?? "");
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  private receiveClose(code: number, reason: string): void {
    if (this.receivedClose) return;
    this.receivedClose = true;
    if (!this.allowHalfOpen && !this.sentClose) {
      // Without half-open, the runtime answers a close frame automatically.
      this.sentClose = true;
      this.peer?.receiveClose(code, reason);
    }
    this.enqueue(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  private reserve(bytes: number): boolean {
    if (this.receivedClose) return false;
    if (
      this.queued.length >= MAX_WEBSOCKET_BUFFER_MESSAGES ||
      this.queuedBytes + bytes > MAX_WEBSOCKET_BUFFER_BYTES
    ) {
      this.queued.length = 0;
      this.queuedBytes = 0;
      this.close(1013, "WebSocket buffer limit exceeded");
      return false;
    }
    this.queuedBytes += bytes;
    return true;
  }

  private enqueue(event: Event): void {
    this.queued.push(event);
    this.deliver();
  }

  private deliver(): void {
    if (!this.accepted || this.delivering) return;
    this.delivering = true;
    // One bounded queue covers both unaccepted sockets and scheduled deliveries.
    queueMicrotask(() => {
      const events = this.queued.splice(0);
      this.queuedBytes = 0;
      this.delivering = false;
      for (const event of events) this.dispatchEvent(event);
    });
  }
}

export class NodeWebSocketPair {
  readonly 0: PairedWebSocket;
  readonly 1: PairedWebSocket;

  constructor() {
    const client = new PairedWebSocket();
    const server = new PairedWebSocket();
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
}

/** Installs the polyfill where the runtime has no native `WebSocketPair`. */
export function installWebSocketPair(): void {
  if (typeof Reflect.get(globalThis, "WebSocketPair") !== "function") {
    Reflect.set(globalThis, "WebSocketPair", NodeWebSocketPair);
  }
}
