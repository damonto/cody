/**
 * Bridges network WebSockets from the `ws` package to Workers-style pair
 * sockets, and connects upstream WebSockets for standard runtimes where
 * `fetch` cannot perform a WebSocket upgrade.
 */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import NetworkSocket, { type RawData } from "ws";
import { withoutHopHeaders } from "../../gateway/transport/http.ts";
import { webSocketUpgradeResponse } from "../websocket-upgrade.ts";
import { incomingResponse, incomingResponseHeaders } from "./http-response.ts";
import { MAX_WEBSOCKET_BUFFER_BYTES } from "./websocket-limits.ts";

const TEXT = new TextDecoder();
const MAX_CLOSE_REASON_BYTES = 123;

function validCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
  );
}

function truncateReason(reason: string): string {
  const bytes = Buffer.from(reason, "utf8");
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let result = "";
  let size = 0;
  for (const character of reason) {
    size += Buffer.byteLength(character);
    if (size > MAX_CLOSE_REASON_BYTES) break;
    result += character;
  }
  return result;
}

/** Closes a network socket with a code the WebSocket protocol allows on the wire. */
export function closeNetworkSocket(
  socket: NetworkSocket,
  code: number,
  reason: string,
): void {
  if (
    socket.readyState === NetworkSocket.CLOSING ||
    socket.readyState === NetworkSocket.CLOSED
  ) {
    return;
  }
  if (code === 1006) {
    socket.terminate();
  } else if (validCloseCode(code)) {
    socket.close(code, truncateReason(reason));
  } else {
    socket.close();
  }
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

/**
 * Connects a network socket to one end of a pair. The pair end is accepted
 * here; the other end belongs to the gateway code.
 */
export function bridgeWebSocket(network: NetworkSocket, peer: WebSocket): void {
  network.binaryType = "arraybuffer";
  peer.accept({ allowHalfOpen: true });
  network.on("message", (data: RawData, isBinary: boolean) => {
    if (peer.readyState !== WebSocket.OPEN) return;
    try {
      peer.send(isBinary ? rawBytes(data) : TEXT.decode(rawBytes(data)));
    } catch {
      closeNetworkSocket(network, 1011, "gateway peer closed");
    }
  });
  peer.addEventListener("message", (event: MessageEvent) => {
    if (network.readyState !== NetworkSocket.OPEN) return;
    const data: unknown = event.data;
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) return;
    const size =
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (size + network.bufferedAmount > MAX_WEBSOCKET_BUFFER_BYTES) {
      peer.close(1013, "WebSocket buffer limit exceeded");
      closeNetworkSocket(network, 1013, "WebSocket buffer limit exceeded");
      return;
    }
    const failed = () => {
      peer.close(1011, "WebSocket send failed");
      network.terminate();
    };
    try {
      network.send(
        typeof data === "string" ? data : Buffer.from(data),
        (error) => {
          if (error) failed();
        },
      );
    } catch {
      failed();
    }
  });
  network.on("close", (code: number, reason: Buffer) => {
    try {
      peer.close(code, TEXT.decode(reason));
    } catch {
      // The pair may already be closed.
    }
  });
  peer.addEventListener("close", (event: CloseEvent) => {
    closeNetworkSocket(network, event.code, event.reason);
    try {
      // Complete the pair's close handshake; the network side has its own.
      peer.close(event.code, event.reason);
    } catch {
      // Already closed.
    }
  });
  // A close event follows every error; the handlers above handle both.
  network.on("error", () => {});
}

function withoutWebSocketHeaders(headers: Headers): Headers {
  for (const name of [...headers.keys()])
    if (name.startsWith("sec-websocket-")) headers.delete(name);
  return headers;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

/**
 * Opens an upstream WebSocket. A successful handshake resolves to a 101
 * response whose `webSocket` is a pair end; any other status resolves to the
 * upstream HTTP response so retries and health accounting see it.
 */
export function connectUpstreamWebSocket(request: Request): Promise<Response> {
  const signal = request.signal;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const url = new URL(request.url);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  const headers: Record<string, string> = {};
  withoutHopHeaders(request.headers).forEach((value, name) => {
    if (
      name !== "host" &&
      name !== "content-length" &&
      !name.startsWith("sec-websocket-")
    ) {
      headers[name] = value;
    }
  });
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let upgradeHeaders = new Headers();
    const socket = new NetworkSocket(url.href, {
      headers,
      perMessageDeflate: false,
      followRedirects: false,
      maxPayload: MAX_WEBSOCKET_BUFFER_BYTES,
    });
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      outcome();
    };
    const onAbort = (): void => {
      socket.terminate();
      settle(() => reject(abortReason(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.on("upgrade", (response: IncomingMessage) => {
      upgradeHeaders = withoutWebSocketHeaders(
        incomingResponseHeaders(response),
      );
    });
    socket.on(
      "unexpected-response",
      (clientRequest: { destroy(): void }, response: IncomingMessage) => {
        try {
          const result = incomingResponse(response, "GET", {
            signal,
            onClose: () => clientRequest.destroy(),
          });
          withoutWebSocketHeaders(result.headers);
          settle(() => resolve(result));
        } catch (error) {
          clientRequest.destroy();
          settle(() => reject(error));
        }
      },
    );
    socket.once("open", () => {
      settle(() => {
        const pair = new WebSocketPair();
        bridgeWebSocket(socket, pair[1]);
        resolve(webSocketUpgradeResponse(pair[0], upgradeHeaders));
      });
    });
    socket.once("error", (error: Error) => {
      settle(() => reject(error));
    });
  });
}
