import * as http from "node:http";
import * as https from "node:https";
import { Writable } from "node:stream";
import type { Socket } from "node:net";
import { decodeResponseBody } from "../../gateway/transport/compression.ts";
import { withoutHopHeaders } from "../../gateway/transport/http.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";

function responseBody(
  incoming: http.IncomingMessage,
): ReadableStream<Uint8Array> {
  const iterator = incoming[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await iterator.next();
          if (done) controller.close();
          else if (value instanceof Uint8Array) controller.enqueue(value);
          else throw new Error("Upstream response is not a byte stream");
        } catch (error) {
          controller.error(error);
          incoming.destroy();
        }
      },
      async cancel() {
        incoming.destroy();
        await iterator.return?.().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

function upstreamResponse(
  incoming: http.IncomingMessage,
  method: string,
): Response {
  // The peer can fail before any body read, including on a bodyless response.
  incoming.on("error", () => {});
  const nativeHeaders = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2)
    nativeHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  const headers = withoutHopHeaders(nativeHeaders);
  const status = incoming.statusCode ?? 502;
  const noBody = method === "HEAD" || [204, 205, 304].includes(status);
  if (noBody) incoming.resume();
  const body = noBody
    ? null
    : decodeResponseBody(responseBody(incoming), headers);
  return new Response(body, {
    status,
    statusText: incoming.statusMessage ?? "",
    headers,
  });
}

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
        let uploading = Promise.resolve();
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
            }
            try {
              const response = upstreamResponse(incoming, request.method);
              void uploading
                .then(() => {
                  if (!outgoing.writableEnded && !outgoing.destroyed)
                    outgoing.end();
                  resolve(response);
                })
                .catch(reject);
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
          uploading = request.body
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
