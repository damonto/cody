import { Buffer } from "node:buffer";
import { ByteReader, STREAM_CHUNK_BYTES, type Connection } from "./bytes.ts";
import { ACCEPT_ENCODING, decodeResponseBody } from "./compression.ts";

const MAX_HEADERS = 64 * 1024;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// oxlint-disable-next-line no-control-regex -- HTTP field values prohibit controls other than HTAB.
const INVALID_HEADER_CHARACTERS = /[\x00-\x08\x0a-\x1f\x7f]/;
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export interface ResponseHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
}

function parseHeader(line: Uint8Array): [string, string] {
  const text = Buffer.from(line).toString("latin1").slice(0, -2);
  const colon = text.indexOf(":");
  const name = text.slice(0, colon);
  const value = text.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
  if (
    colon < 1 ||
    !HEADER_NAME_PATTERN.test(name) ||
    INVALID_HEADER_CHARACTERS.test(value)
  ) {
    throw new Error("Invalid upstream HTTP header");
  }
  return [name, value];
}

export function withoutHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (HEADER_NAME_PATTERN.test(name.trim())) {
      headers.delete(name.trim());
    }
  }
  for (const name of HOP_HEADERS) {
    headers.delete(name);
  }
  return headers;
}

export async function readResponseHead(
  reader: ByteReader,
): Promise<ResponseHead> {
  let remaining = MAX_HEADERS;
  for (let informational = 0; informational < 16; informational += 1) {
    const first = await reader.readLine(remaining);
    remaining -= first.length;
    const status =
      /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: ([\t\x20-\x7e\x80-\xff]*))?\r\n$/.exec(
        Buffer.from(first).toString("latin1"),
      );
    if (!status) {
      throw new Error("Invalid upstream HTTP status line");
    }
    const headers = new Headers();
    for (let count = 0; ; count += 1) {
      if (count > 256) {
        throw new Error("Too many upstream HTTP headers");
      }
      const line = await reader.readLine(remaining);
      remaining -= line.length;
      if (line.length === 2) {
        break;
      }
      const [name, value] = parseHeader(line);
      headers.append(name, value);
    }
    const code = Number(status[1]);
    if (code === 101 || code >= 200) {
      return {
        status: code,
        statusText: status[2] ?? "",
        headers,
      };
    }
  }
  throw new Error("Too many informational upstream HTTP responses");
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const lengths = value.split(",").map((part) => part.trim());
  if (
    !lengths.every(
      (part) => /^[0-9]+$/.test(part) && Number(part) === Number(lengths[0]),
    ) ||
    !Number.isSafeInteger(Number(lengths[0]))
  ) {
    throw new Error("Invalid upstream HTTP content length");
  }
  return Number(lengths[0]);
}

/** Decode HTTP framing incrementally; cancellation closes the SOCKS/TLS connection. */
export async function responseFromHead(
  head: ResponseHead,
  reader: ByteReader,
  connection: Connection,
  signal: AbortSignal,
  method: string,
): Promise<Response> {
  if (head.status === 101) {
    throw new Error("Unexpected upstream HTTP upgrade");
  }
  const headers = withoutHopHeaders(head.headers);
  if (
    method === "HEAD" ||
    head.status === 204 ||
    head.status === 205 ||
    head.status === 304
  ) {
    await connection.close();
    return new Response(null, {
      status: head.status,
      statusText: head.statusText,
      headers,
    });
  }
  let remaining = contentLength(head.headers);
  const transfer = head.headers.get("transfer-encoding")?.toLowerCase().trim();
  if (transfer && (transfer !== "chunked" || remaining !== undefined)) {
    throw new Error("Invalid upstream HTTP transfer encoding");
  }
  const chunked = transfer === "chunked";
  let chunkRemaining = 0;
  let chunkTerminator = false;
  let finished = false;
  let abort: () => void = () => {};
  const close = (): Promise<void> => {
    finished = true;
    signal.removeEventListener("abort", abort);
    return connection.close();
  };
  const source = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          if (finished) {
            return;
          }
          controller.error(
            signal.reason ?? new DOMException("Aborted", "AbortError"),
          );
          // Teardown is idempotent and is also awaited by pull()/cancel().
          void close();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      },
      async pull(controller) {
        if (finished) {
          return;
        }
        try {
          signal.throwIfAborted();
          if (chunked && chunkRemaining === 0) {
            if (chunkTerminator) {
              const end = await reader.readExactly(2);
              if (end[0] !== 13 || end[1] !== 10) {
                throw new Error("Invalid upstream HTTP chunk terminator");
              }
            }
            const line = Buffer.from(await reader.readLine(8192)).toString(
              "latin1",
            );
            const match = /^([0-9a-f]+)(?:;[^\r\n]*)?\r\n$/i.exec(line);
            if (
              !match ||
              INVALID_HEADER_CHARACTERS.test(line.slice(0, -2)) ||
              !Number.isSafeInteger(Number.parseInt(match[1], 16))
            ) {
              throw new Error("Invalid upstream HTTP chunk size");
            }
            chunkRemaining = Number.parseInt(match[1], 16);
            chunkTerminator = true;
            if (chunkRemaining === 0) {
              let trailerBudget = MAX_HEADERS;
              for (let count = 0; ; count += 1) {
                if (count > 256) {
                  throw new Error("Too many upstream HTTP trailers");
                }
                const trailer = await reader.readLine(trailerBudget);
                trailerBudget -= trailer.length;
                if (trailer.length === 2) {
                  break;
                }
                parseHeader(trailer);
              }
              await close();
              controller.close();
              return;
            }
          }
          if (!chunked && remaining === 0) {
            await close();
            controller.close();
            return;
          }
          const part = await reader.readSome(
            Math.min(
              STREAM_CHUNK_BYTES,
              chunked ? chunkRemaining : (remaining ?? Infinity),
            ),
          );
          // cancel() can finish the stream while a socket read is pending.
          if (finished) {
            return;
          }
          if (part === null) {
            if (chunked || remaining !== undefined) {
              throw new Error("Truncated upstream HTTP body");
            }
            await close();
            controller.close();
            return;
          }
          if (chunked) {
            chunkRemaining -= part.length;
          } else if (remaining !== undefined) {
            remaining -= part.length;
          }
          controller.enqueue(part);
          if (!chunked && remaining === 0) {
            await close();
            controller.close();
          }
        } catch (error) {
          await close();
          controller.error(error);
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
  try {
    return new Response(decodeResponseBody(source, headers), {
      status: head.status,
      statusText: head.statusText,
      headers,
    });
  } catch (error) {
    await source.cancel();
    throw error;
  }
}

export async function httpOverConnection(
  request: Request,
  connection: Connection,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = withoutHopHeaders(request.headers);
  headers.set("host", url.host);
  headers.set("connection", "close");
  headers.set("accept-encoding", ACCEPT_ENCODING);
  headers.delete("expect");
  headers.delete("content-length");
  if (request.body) {
    headers.set("transfer-encoding", "chunked");
  }
  const lines = [
    `${request.method} ${url.pathname || "/"}${url.search} HTTP/1.1`,
  ];
  headers.forEach((value, name) => {
    lines.push(`${name}: ${value}`);
  });
  const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
  if (head.length > MAX_HEADERS) {
    throw new Error("Upstream request headers exceed their limit");
  }
  await connection.write(head);
  const body = request.body?.getReader();
  // Four hex digits and two CRLFs must fit alongside the data in one record.
  const chunkBytes =
    Math.min(
      STREAM_CHUNK_BYTES,
      connection.writeChunkBytes ?? STREAM_CHUNK_BYTES,
    ) - 8;
  let responded = false;
  const upload = (async () => {
    if (!body) {
      return;
    }
    try {
      while (!responded) {
        const next = await body.read();
        if (responded) {
          break;
        }
        if (next.done) {
          await connection.write(Buffer.from("0\r\n\r\n"));
          return;
        }
        // Bound TLS encryption work even when the request body is a single large buffer.
        for (
          let offset = 0;
          offset < next.value.length && !responded;
          offset += chunkBytes
        ) {
          const part = next.value.subarray(offset, offset + chunkBytes);
          // Encrypt framing and data together, without separate tiny TLS records
          // for the length and CRLF or buffering across request stream chunks.
          await connection.write(
            Buffer.concat([
              Buffer.from(`${part.length.toString(16)}\r\n`),
              part,
              Buffer.from("\r\n"),
            ]),
          );
        }
      }
    } catch {
      // A failed upload invalidates a pending response, but an origin may have
      // already sent a useful early rejection without consuming the whole body.
      if (!responded) {
        await connection.close();
      }
    } finally {
      // Cancellation can reject when the request body already errored.
      await body.cancel().catch(() => {});
      body.releaseLock();
    }
  })();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      responded = true;
      // Both directions must stop: cancelling only the response can leave the
      // upload waiting on either its request reader or a blocked socket writer.
      await Promise.allSettled([connection.close(), body?.cancel()]);
      await upload;
    })();
    return closing;
  };
  const reader = new ByteReader(() => connection.read());
  try {
    const result = await readResponseHead(reader);
    responded = true;
    // Stop the request reader even when it has not yielded another upload chunk.
    await body?.cancel().catch(() => {});
    return await responseFromHead(
      result,
      reader,
      {
        read: () => connection.read(),
        write: (data) => connection.write(data),
        close,
      },
      request.signal,
      request.method,
    );
  } catch (error) {
    responded = true;
    await close();
    throw error;
  }
}
