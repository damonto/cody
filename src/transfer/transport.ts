import { readBodyWithinLimit } from "../gateway/http/body.ts";
import { MAX_TRANSFER_BYTES, TransferError } from "./protocol.ts";

/** Bound JSON before parsing it; neither errors nor logs include the payload. */
export async function readTransferJson(
  response: Pick<Response, "body" | "headers">,
): Promise<unknown> {
  try {
    const bytes = await readBodyWithinLimit(
      response.body,
      MAX_TRANSFER_BYTES,
      response.headers.get("content-length"),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TransferError(
      "Transfer response is invalid JSON or exceeds the size limit",
    );
  }
}
