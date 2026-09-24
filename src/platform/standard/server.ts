import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type { StandardRuntime } from "./runtime.ts";
import { bridgeWebSocket, closeNetworkSocket } from "./websocket-bridge.ts";
import { MAX_WEBSOCKET_BUFFER_BYTES } from "./websocket-limits.ts";

export interface NodeServer {
  readonly server: Server;
  close(): Promise<void>;
}

/** HTTP/SSE and authenticated Responses upgrades share the same app. */
export function createNodeServer(runtime: StandardRuntime): NodeServer {
  const listener = getRequestListener((request) => runtime.fetch(request), {
    overrideGlobalObjects: false,
  });
  const server = createServer((incoming, outgoing) => {
    void listener(incoming, outgoing).catch(() => outgoing.destroy());
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_BUFFER_BYTES,
    perMessageDeflate: false,
  });
  const upgradeHeaders = new WeakMap<IncomingMessage, Headers>();
  sockets.on("headers", (headers, request) => {
    upgradeHeaders.get(request)?.forEach((value, name) => {
      if (
        ![
          "connection",
          "upgrade",
          "sec-websocket-accept",
          "sec-websocket-protocol",
          "sec-websocket-extensions",
          "content-length",
        ].includes(name)
      )
        headers.push(`${name}: ${value}`);
    });
  });
  const upgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    socket.once("close", abort);
    let peer: WebSocket | undefined;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        for (const entry of Array.isArray(value) ? value : [value])
          headers.append(name, entry);
      }
      const response = await runtime.fetch(
        new Request(
          new URL(
            request.url ?? "/",
            `http://${request.headers.host ?? "localhost"}`,
          ),
          {
            method: request.method ?? "GET",
            headers,
            signal: controller.signal,
          },
        ),
      );
      peer = response.webSocket ?? undefined;
      if (socket.destroyed) {
        peer?.close(1001, "client disconnected");
        return;
      }
      if (response.status === 101 && peer) {
        upgradeHeaders.set(request, response.headers);
        const accepted = peer;
        sockets.handleUpgrade(request, socket, head, (network) => {
          bridgeWebSocket(network, accepted);
          sockets.emit("connection", network, request);
        });
      } else {
        const body = Buffer.from(await response.arrayBuffer());
        const outgoing = new Headers(response.headers);
        outgoing.set("connection", "close");
        outgoing.set("content-length", String(body.byteLength));
        outgoing.delete("transfer-encoding");
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 ${response.status} ${response.statusText}\r\n${[...outgoing].map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`,
            ),
            body,
          ]),
        );
      }
    } catch {
      peer?.close(1011, "upgrade failed");
      socket.destroy();
    } finally {
      socket.removeListener("close", abort);
    }
  };
  server.on("upgrade", (request, socket, head) => {
    runtime.tasks.track(upgrade(request, socket, head));
  });
  return {
    server,
    async close() {
      for (const socket of sockets.clients)
        closeNetworkSocket(socket, 1001, "server shutting down");
      const timeout = setTimeout(() => {
        for (const socket of sockets.clients) socket.terminate();
        server.closeAllConnections();
      }, 10_000);
      timeout.unref();
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        sockets.close();
        await runtime.close();
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
