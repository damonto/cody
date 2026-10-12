import { versions } from "node:process";
import { removeEncodedBodyHeaders } from "../../gateway/transport/compression.ts";
import { withoutHopHeaders } from "../../gateway/transport/http.ts";

const DECODED_ENCODINGS = new Set(["gzip", "x-gzip", "deflate", "br"]);
const [undiciMajor = 0, undiciMinor = 0] = (versions.undici ?? "")
  .split(".")
  .map(Number);
// Early Node 24 releases bundled Undici 7.10, which leaves zstd encoded.
if (undiciMajor > 7 || (undiciMajor === 7 && undiciMinor >= 11))
  DECODED_ENCODINGS.add("zstd");

/** Native fetch decodes the body but retains headers describing the wire bytes. */
export async function fetchUpstream(request: Request): Promise<Response> {
  const response = await fetch(request);
  const headers = withoutHopHeaders(response.headers);
  const encodings = (response.headers.get("content-encoding") ?? "")
    .toLowerCase()
    .split(",")
    .map((encoding) => encoding.trim());
  // Unknown encodings (including mixed chains) are passed through by fetch.
  // HEAD and bodyless statuses still describe the original representation.
  if (
    response.body &&
    encodings.every((encoding) => DECODED_ENCODINGS.has(encoding))
  )
    removeEncodedBodyHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
