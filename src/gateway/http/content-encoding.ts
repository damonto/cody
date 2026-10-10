import { constants, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { BodyTooLargeError } from "./body.ts";

const decompressZstd = promisify(zstdDecompress);

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
    try {
      decoded = await decompressZstd(decoded, {
        maxOutputLength: maxBytes,
        params: {
          [constants.ZSTD_d_windowLogMax]: Math.max(
            10,
            Math.ceil(Math.log2(maxBytes)),
          ),
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_BUFFER_TOO_LARGE"
      )
        throw new BodyTooLargeError(maxBytes);
      throw new ContentEncodingError(
        400,
        "Request body must contain valid zstd data",
      );
    }
    signal.throwIfAborted();
  }
  return decoded;
}
