import { Buffer } from "node:buffer";
import websocketDriver from "websocket-driver";
import { webSocketUpgradeResponse } from "../../platform/websocket-upgrade.ts";
import { closeSocket } from "../websocket/websocket-protocol.ts";
import { ByteReader, type Connection } from "./bytes.ts";
import { ACCEPT_ENCODING } from "./compression.ts";
import {
  readResponseHead,
  responseFromHead,
  withoutHopHeaders,
} from "./http.ts";

const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/** Adapt the RFC 6455 driver to the native WebSocket API used by the existing DO. */
export async function websocketOverConnection(
  request: Request,
  connection: Connection,
): Promise<Response> {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const driver = websocketDriver.client(url.href, {
    maxLength: MAX_PENDING_BYTES,
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
  const fail = (): void => {
    failure ??= new Error("Upstream SOCKS5 WebSocket connection failed");
    ended = true;
    closeSocket(peer, 1011, "upstream connection failed");
    // Handshake failures and the established pump also await this teardown.
    void disconnect();
  };
  const aborted = (): void => {
    fail();
  };
  request.signal.addEventListener("abort", aborted, { once: true });
  driver.on("error", fail);
  driver.on("open", () => {
    opened = true;
  });
  driver.io.on("data", (data) => {
    if (ended) {
      return;
    }
    queuedBytes += data.length;
    if (queuedBytes > MAX_PENDING_BYTES) {
      fail();
      return;
    }
    writes = writes
      .then(async () => {
        await connection.write(data);
        queuedBytes -= data.length;
      })
      .catch(fail);
  });
  driver.on("message", ({ data }) => {
    if (!peer || ended) {
      return;
    }
    try {
      peer.send(typeof data === "string" ? data : new Uint8Array(data));
    } catch {
      fail();
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
          fail();
        }
      } catch {
        fail();
      }
    });
    peer.addEventListener("error", fail);
    peer.addEventListener("close", ({ code, reason }) => {
      if (ended) {
        return;
      }
      driver.close(reason, code === 1005 ? 1000 : code === 1006 ? 1011 : code);
      closeTimer = setTimeout(fail, 1000);
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
      try {
        while (!ended) {
          const part = await reader.readSome();
          if (part === null) {
            if (!ended) {
              fail();
            }
            break;
          }
          driver.parse(Buffer.from(part));
          // Apply backpressure to ping/close replies as well as application frames.
          await writes;
        }
      } catch {
        if (!ended) {
          fail();
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
    fail();
    await disconnect();
    throw error;
  }
}
