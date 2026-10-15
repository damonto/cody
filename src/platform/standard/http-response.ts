import type { IncomingMessage } from "node:http";
import { decodeResponseBody } from "../../gateway/transport/compression.ts";
import { withoutHopHeaders } from "../../gateway/transport/http.ts";

export function incomingResponseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2)
    headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  return withoutHopHeaders(headers);
}

interface IncomingResponseOptions {
  readonly signal?: AbortSignal;
  /** A rejected WebSocket handshake still owns an unfinished client request. */
  readonly onClose?: () => void;
}

/** Stream native HTTP responses with the same decoding and cancellation contract. */
export function incomingResponse(
  incoming: IncomingMessage,
  method: string,
  options: IncomingResponseOptions = {},
): Response {
  // The peer can fail before the consumer's first body read.
  incoming.on("error", () => {});
  const headers = incomingResponseHeaders(incoming);
  const status = incoming.statusCode ?? 502;
  const noBody = method === "HEAD" || [204, 205, 304].includes(status);
  let cleaned = false;
  let cancelled = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    options.signal?.removeEventListener("abort", abort);
    options.onClose?.();
  };
  const abort = (): void => {
    cancelled = true;
    try {
      controller?.error(options.signal?.reason);
    } finally {
      incoming.destroy();
      cleanup();
    }
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (noBody) {
    incoming.once("end", cleanup);
    incoming.once("close", cleanup);
    incoming.resume();
    if (options.signal?.aborted) abort();
    return new Response(null, {
      status,
      statusText: incoming.statusMessage ?? "",
      headers,
    });
  }
  const iterator = incoming[Symbol.asyncIterator]();
  const source = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        if (options.signal?.aborted) abort();
      },
      async pull(value) {
        try {
          const next = await iterator.next();
          if (cancelled) return;
          if (next.done) {
            cleanup();
            value.close();
          } else if (next.value instanceof Uint8Array) {
            value.enqueue(next.value);
          } else throw new Error("Upstream response is not a byte stream");
        } catch (error) {
          if (!cancelled) value.error(error);
          incoming.destroy();
          cleanup();
        }
      },
      async cancel() {
        cancelled = true;
        incoming.destroy();
        cleanup();
        await iterator.return?.().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  try {
    return new Response(decodeResponseBody(source, headers), {
      status,
      statusText: incoming.statusMessage ?? "",
      headers,
    });
  } catch (error) {
    void source.cancel().catch(() => {});
    throw error;
  }
}
