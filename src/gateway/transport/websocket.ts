import { Buffer } from "node:buffer";
import websocketDriver from "websocket-driver";
import { webSocketUpgradeResponse } from "../../platform/websocket-upgrade.ts";
import { closeSocket } from "../websocket/websocket-protocol.ts";
import { ByteReader, type Connection } from "./bytes.ts";
import { ACCEPT_ENCODING } from "./compression.ts";
import { elapsedMs } from "../../shared/log.ts";
import {
  readResponseHead,
  responseFromHead,
  withoutHopHeaders,
} from "./http.ts";

import {
  MAX_WEBSOCKET_BUFFER_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
} from "../../shared/payload-limits.ts";

export interface WebSocketTransportFailure {
  readonly stage:
    | "handshake"
    | "read"
    | "write"
    | "protocol"
    | "forward"
    | "buffer_limit"
    | "close_timeout"
    | "abort";
  readonly phase: "connecting" | "open";
  readonly duration_ms: number;
  readonly received_bytes: number;
  readonly sent_bytes: number;
  readonly error: unknown;
}

/** Adapt the RFC 6455 driver to the native WebSocket API used by the existing DO. */
export async function websocketOverConnection(
  request: Request,
  connection: Connection,
  onFailure?: (diagnostic: WebSocketTransportFailure) => void,
): Promise<Response> {
  const startedAt = performance.now();
  let receivedBytes = 0;
  let sentBytes = 0;
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const driver = websocketDriver.client(url.href, {
    maxLength: MAX_WEBSOCKET_MESSAGE_BYTES,
  });
  let writes = Promise.resolve();
  let queuedBytes = 0;
  let opened = false;
  let ended = false;
  let failure: Error | undefined;
  let peer: WebSocket | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let disconnecting: Promise<void> | undefined;
  const disconnect = (): Promise<void> => {
    disconnecting ??= (async () => {
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer);
      }
      request.signal.removeEventListener("abort", aborted);
      await connection.close();
    })();
    return disconnecting;
  };
  const fail = (
    stage: WebSocketTransportFailure["stage"],
    error: unknown,
  ): void => {
    const firstFailure = failure === undefined;
    failure ??= new Error("Upstream SOCKS5 WebSocket connection failed");
    ended = true;
    closeSocket(peer, 1011, "upstream connection failed");
    // Handshake failures and the established pump also await this teardown.
    void disconnect();
    if (firstFailure) {
      try {
        onFailure?.({
          stage,
          phase: opened ? "open" : "connecting",
          duration_ms: elapsedMs(startedAt),
          received_bytes: receivedBytes,
          sent_bytes: sentBytes,
          error,
        });
      } catch {
        // Diagnostics must never interfere with socket teardown.
      }
    }
  };
  const aborted = (): void => {
    fail("abort", request.signal.reason);
  };
  request.signal.addEventListener("abort", aborted, { once: true });
  driver.on("error", (error) => fail("protocol", error));
  driver.on("open", () => {
    opened = true;
  });
  driver.io.on("data", (data) => {
    if (ended) {
      return;
    }
    queuedBytes += data.length;
    if (queuedBytes > MAX_WEBSOCKET_BUFFER_BYTES) {
      fail("buffer_limit", new Error("WebSocket write buffer limit exceeded"));
      return;
    }
    writes = writes
      .then(async () => {
        await connection.write(data);
        sentBytes += data.length;
        queuedBytes -= data.length;
      })
      .catch((error) => fail("write", error));
  });
  driver.on("message", ({ data }) => {
    if (!peer || ended) {
      return;
    }
    try {
      peer.send(typeof data === "string" ? data : new Uint8Array(data));
    } catch (error) {
      fail("forward", error);
    }
  });
  driver.on("close", ({ code, reason }) => {
    if (ended) {
      return;
    }
    ended = true;
    closeSocket(peer, code, reason);
    // Flush the protocol's close reply, but never wait indefinitely for a broken socket.
    closeTimer = setTimeout(() => {
      void disconnect();
    }, 1000);
    // The accepted WebSocket/TCP I/O owns this bounded close handshake.
    void writes.then(disconnect, disconnect);
  });
  const headers = withoutHopHeaders(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("accept-encoding", ACCEPT_ENCODING);
  headers.forEach((value, name) => {
    if (!name.startsWith("sec-websocket-")) {
      driver.setHeader(name, value);
    }
  });
  try {
    request.signal.throwIfAborted();
    driver.start();
    await writes;
    if (failure) {
      throw failure;
    }
    const reader = new ByteReader(() => connection.read());
    const head = await readResponseHead(reader);
    if (head.status !== 101) {
      // HTTP errors retain their status and body for configured retries and health accounting.
      request.signal.removeEventListener("abort", aborted);
      return await responseFromHead(
        head,
        reader,
        connection,
        request.signal,
        "GET",
      );
    }
    const pair = new WebSocketPair();
    peer = pair[1];
    peer.binaryType = "arraybuffer";
    peer.accept({ allowHalfOpen: true });
    peer.addEventListener("message", ({ data }) => {
      if (ended) {
        return;
      }
      try {
        if (typeof data === "string") {
          driver.text(data);
        } else if (data instanceof ArrayBuffer) {
          driver.binary(Buffer.from(data));
        } else {
          fail("forward", new Error("Unsupported WebSocket message type"));
        }
      } catch (error) {
        fail("protocol", error);
      }
    });
    peer.addEventListener("error", (event) =>
      fail(
        "forward",
        Reflect.get(event, "error") ?? new Error("WebSocket peer error"),
      ),
    );
    peer.addEventListener("close", ({ code, reason }) => {
      if (ended) {
        return;
      }
      driver.close(reason, code === 1005 ? 1000 : code === 1006 ? 1011 : code);
      closeTimer = setTimeout(
        () =>
          fail(
            "close_timeout",
            new Error("Upstream WebSocket close handshake timed out"),
          ),
        1000,
      );
    });
    // Connection is a token list; the driver's older HTTP validator expects one token.
    if (
      !(head.headers.get("connection") ?? "")
        .split(",")
        .some((value) => value.trim().toLowerCase() === "upgrade")
    ) {
      throw new Error("Invalid upstream WebSocket upgrade");
    }
    const handshakeHeaders = new Headers(head.headers);
    handshakeHeaders.set("connection", "Upgrade");
    const lines = [`HTTP/1.1 101 ${head.statusText}`];
    handshakeHeaders.forEach((value, name) => {
      lines.push(`${name}: ${value}`);
    });
    driver.parse(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"));
    if (!opened || failure) {
      throw failure ?? new Error("Invalid upstream WebSocket handshake");
    }
    const pump = async (): Promise<void> => {
      let stage: "read" | "protocol" = "read";
      try {
        while (!ended) {
          stage = "read";
          const part = await reader.readSome();
          if (part === null) {
            if (!ended) {
              fail(
                "read",
                new Error(
                  "Upstream connection ended without a WebSocket close frame",
                ),
              );
            }
            break;
          }
          receivedBytes += part.byteLength;
          stage = "protocol";
          driver.parse(Buffer.from(part));
          // Apply backpressure to ping/close replies as well as application frames.
          await writes;
        }
      } catch (error) {
        if (!ended) {
          fail(stage, error);
        }
      } finally {
        await disconnect();
      }
    };
    // Outgoing sockets and the accepted pair keep the Durable Object active.
    // This is response I/O, not a post-response task for ctx.waitUntil().
    void pump();
    return webSocketUpgradeResponse(pair[0], withoutHopHeaders(head.headers));
  } catch (error) {
    fail("handshake", error);
    await disconnect();
    throw error;
  }
}
