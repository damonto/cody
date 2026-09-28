import { ProviderRequestError } from "../errors.ts";
import type { Wire } from "./json.ts";
import { z } from "zod";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const eventSchema = z
  .object({
    type: z.string().min(1),
    delta: z.string().optional(),
    output_index: z.number().int().min(0).max(1023).optional(),
    item: z
      .object({ type: z.string().min(1) })
      .passthrough()
      .optional(),
    response: z
      .object({
        output: z
          .array(z.object({ type: z.string().min(1) }).passthrough())
          .max(1024)
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
/** Bounded SSE parsing shared by both downstream dialects and nonstream aggregation. */
export async function* xaiEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Wire> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.value && chunk.value.byteLength > MAX_FRAME_BYTES)
        throw new ProviderRequestError("xAI SSE chunk exceeds limit", 502);
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (frame.length > MAX_FRAME_BYTES)
          throw new ProviderRequestError("xAI SSE frame exceeds limit", 502);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          try {
            yield eventSchema.parse(JSON.parse(data));
          } catch (error) {
            if (error instanceof ProviderRequestError) throw error;
            throw new ProviderRequestError("Invalid xAI SSE event", 502);
          }
        }
      }
      if (pending.length > MAX_FRAME_BYTES)
        throw new ProviderRequestError("xAI SSE frame exceeds limit", 502);
      if (chunk.done) {
        if (pending.trim() && !pending.trim().startsWith(":"))
          throw new ProviderRequestError("Truncated xAI SSE event", 502);
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
