import { constants, createZstdDecompress } from "node:zlib";
import { BodyTooLargeError, readBodyWithinLimit } from "./body.ts";

export class ContentEncodingError extends Error {
  constructor(
    readonly status: 400 | 415,
    message: string,
  ) {
    super(message);
    this.name = "ContentEncodingError";
  }
}

/** Decode for routing while retaining the original bytes for unchanged requests. */
export async function decodeRequestBody(
  body: Uint8Array<ArrayBuffer>,
  contentEncoding: string | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const encodings = (contentEncoding ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== "identity");
  if (encodings.some((encoding) => encoding !== "zstd"))
    throw new ContentEncodingError(415, "Unsupported request content encoding");
  let decoded = body;
  for (const _encoding of encodings.reverse()) {
    signal.throwIfAborted();
    const decoder = createZstdDecompress({
      params: {
        [constants.ZSTD_d_windowLogMax]: Math.max(
          10,
          Math.ceil(Math.log2(maxBytes)),
        ),
      },
    });
    const chunks = decoder[Symbol.asyncIterator]();
    try {
      // Use the runtime's Web Stream: Node's toWeb() does not expose Workers' BYOB API.
      const output = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const chunk = await chunks.next();
            if (chunk.done) controller.close();
            else if (chunk.value instanceof Uint8Array)
              controller.enqueue(chunk.value);
            else throw new TypeError("Zstd decoder returned a non-byte chunk");
          },
          cancel() {
            decoder.destroy();
          },
        },
        { highWaterMark: 0 },
      );
      decoder.end(decoded);
      decoded = await readBodyWithinLimit(
        output,
        maxBytes,
        undefined,
        undefined,
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof BodyTooLargeError) throw error;
      throw new ContentEncodingError(
        400,
        "Request body must contain valid zstd data",
      );
    } finally {
      decoder.destroy();
      await chunks.return?.().catch(() => {});
    }
    signal.throwIfAborted();
  }
  return decoded;
}
