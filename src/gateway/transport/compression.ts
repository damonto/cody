import { createBrotliDecompress } from "node:zlib";
import { STREAM_CHUNK_BYTES } from "./bytes.ts";

export const ACCEPT_ENCODING = "gzip, deflate, br";
const MAX_CONTENT_ENCODINGS = 4;
const SUPPORTED_ENCODINGS = new Set(["gzip", "deflate", "br"]);

/** Bridge the decoder's readable events to native Web Streams with backpressure. */
function brotliStream(): ReadableWritablePair<Uint8Array, Uint8Array> {
  const decoder = createBrotliDecompress({
    chunkSize: STREAM_CHUNK_BYTES,
  });
  let ended = false;
  let stopped = false;
  let resumeRead: (() => void) | undefined;
  let rejectWrite: ((reason: unknown) => void) | undefined;
  let readableController:
    ReadableStreamDefaultController<Uint8Array> | undefined;
  let writableController: WritableStreamDefaultController | undefined;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const terminate = (reason: unknown): Promise<void> => {
    if (!stopped) {
      stopped = true;
      readableController?.error(reason);
      // A decoder can fail while the source is waiting for its next chunk.
      // Error the sink explicitly so pipeTo() cancels that pending source read.
      writableController?.error(reason);
      resumeRead?.();
      // Brotli may emit "error" without invoking the pending write callback.
      // Settle it here so pipeTo() can finish cancelling the upstream source.
      const reject = rejectWrite;
      rejectWrite = undefined;
      reject?.(reason);
      decoder.destroy();
    }
    return closed;
  };
  const resume = (): void => {
    const pending = resumeRead;
    resumeRead = undefined;
    pending?.();
  };
  decoder.on("readable", resume);
  decoder.once("end", () => {
    ended = true;
    resume();
  });
  decoder.on("error", (error: Error) => {
    void terminate(error);
  });
  decoder.once("close", () => {
    if (!ended && !stopped) {
      void terminate(new Error("Upstream Brotli decoder closed unexpectedly"));
    }
    resolveClosed?.();
  });
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        readableController = controller;
      },
      async pull(controller) {
        try {
          while (!stopped) {
            const chunk: unknown = decoder.read();
            if (chunk !== null) {
              if (!(chunk instanceof Uint8Array)) {
                throw new TypeError("Brotli decoder returned a non-byte chunk");
              }
              controller.enqueue(chunk);
              return;
            } else if (ended) {
              controller.close();
              return;
            }
            await new Promise<void>((resolve) => {
              resumeRead = resolve;
            });
          }
        } catch (error) {
          await terminate(error);
        }
      },
      cancel: terminate,
    },
    { highWaterMark: 0 },
  );
  const writable = new WritableStream<Uint8Array>({
    start(controller) {
      writableController = controller;
    },
    async write(chunk: Uint8Array) {
      try {
        await new Promise<void>((resolve, reject) => {
          rejectWrite = reject;
          decoder.write(chunk, (error) => {
            rejectWrite = undefined;
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      } catch (error) {
        await terminate(error);
        throw error;
      }
    },
    async close() {
      try {
        await new Promise<void>((resolve, reject) => {
          rejectWrite = reject;
          decoder.end((error?: Error | null) => {
            rejectWrite = undefined;
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      } catch (error) {
        await terminate(error);
        throw error;
      }
    },
    abort: terminate,
  });
  return { readable, writable };
}

export function decodeResponseBody(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
): ReadableStream<Uint8Array> {
  const encodings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && part !== "identity");
  // Validate the whole list before creating any streams. Rejecting halfway through
  // would leave the source locked in a partially constructed decoder pipeline.
  if (
    encodings.length > MAX_CONTENT_ENCODINGS ||
    encodings.some((encoding) => !SUPPORTED_ENCODINGS.has(encoding))
  ) {
    throw new Error("Unsupported upstream HTTP content encoding");
  }
  for (const encoding of encodings.reverse()) {
    if (encoding === "gzip" || encoding === "deflate") {
      body = body.pipeThrough(new DecompressionStream(encoding));
    } else {
      body = body.pipeThrough(brotliStream());
    }
  }
  if (encodings.length) {
    for (const name of [
      "content-encoding",
      "content-length",
      "content-md5",
      "digest",
      "content-digest",
      "repr-digest",
    ]) {
      headers.delete(name);
    }
  }
  return body;
}
