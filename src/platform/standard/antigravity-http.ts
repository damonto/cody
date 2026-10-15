import * as http from "node:http";
import * as https from "node:https";
import { Writable } from "node:stream";
import type { Socket } from "node:net";
import { withoutHopHeaders } from "../../gateway/transport/http.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import { incomingResponse } from "./http-response.ts";

export interface AntigravityHttpOptions extends Pick<https.AgentOptions, "ca"> {
  readonly idleTimeoutMs?: number;
  readonly waitUntil?: (task: Promise<void>) => void;
}

/** No redirects or implicit retries. Native HTTP/1.1 pooling omits TLS ALPN. */
export function createAntigravityHttpConnector(
  options: AntigravityHttpOptions = {},
): { send: UpstreamFetch; close(): void } {
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0)
    throw new RangeError("HTTP idle timeout must be positive and finite");
  const settings = {
    keepAlive: true,
    maxFreeSockets: 2,
    timeout: idleTimeoutMs,
  };
  const plain = new http.Agent(settings);
  const secure = new https.Agent({
    ...settings,
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    ALPNProtocols: [],
  });
  let closed = false;
  const idle = new Map<Socket, () => void>();
  const reuse = (socket: Socket) => idle.get(socket)?.();
  for (const agent of [plain, secure]) {
    agent.on("free", (socket: Socket) => {
      if (
        !options.waitUntil ||
        idle.has(socket) ||
        !Object.values(agent.freeSockets).some((sockets) =>
          sockets?.includes(socket),
        )
      )
        return;
      // Node owns the idle timeout; retain the invocation until it closes or reuses this socket.
      const task = new Promise<void>((resolve) => {
        const finish = () => {
          socket.removeListener("close", finish);
          idle.delete(socket);
          resolve();
        };
        idle.set(socket, finish);
        socket.once("close", finish);
      });
      try {
        options.waitUntil(task);
      } catch {
        socket.destroy();
      }
    });
  }
  return {
    close() {
      closed = true;
      plain.destroy();
      secure.destroy();
    },
    async send(request) {
      if (closed) throw new Error("Antigravity HTTP connector is closed");
      request.signal.throwIfAborted();
      const url = new URL(request.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Antigravity transport requires an HTTP or HTTPS URL");
      return new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(withoutHopHeaders(request.headers));
        const secureRequest = url.protocol === "https:";
        let received = false;
        const stopUpload = new AbortController();
        const outgoing = (secureRequest ? https : http).request(
          url.href,
          {
            method: request.method,
            headers,
            agent: secureRequest ? secure : plain,
            signal: request.signal,
          },
          (incoming) => {
            received = true;
            if (!outgoing.writableFinished) {
              // A fixed-length upload may be incomplete at the peer; never reuse that socket.
              outgoing.shouldKeepAlive = false;
              stopUpload.abort();
              if (!outgoing.writableEnded && !outgoing.destroyed)
                outgoing.end();
            }
            try {
              // A producer may cancel asynchronously. The received response
              // owns the socket now and must not wait for that cleanup.
              resolve(incomingResponse(incoming, request.method));
            } catch (error) {
              incoming.destroy();
              reject(error);
            }
          },
        );
        outgoing.removeHeader("connection");
        outgoing.once("socket", reuse);
        outgoing.once("error", reject);
        outgoing.once("close", () => {
          // An unsupported upgrade closes without emitting a response or error.
          if (!received)
            reject(new Error("Upstream connection closed before a response"));
        });
        if (request.body) {
          void request.body
            .pipeTo(Writable.toWeb(outgoing), {
              signal: stopUpload.signal,
              preventAbort: true,
            })
            .catch((error: unknown) => {
              if (!received)
                outgoing.destroy(
                  error instanceof Error
                    ? error
                    : new Error("Upstream upload failed"),
                );
            });
        } else outgoing.end();
      });
    },
  };
}
