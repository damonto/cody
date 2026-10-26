import { ProviderRequestError } from "../errors.ts";
import type { Wire } from "./json.ts";
import { z } from "zod";
import { SseObserver } from "../../telemetry/stream.ts";
import { MAX_SSE_EVENT_BYTES } from "../../shared/payload-limits.ts";

// Drain parsed events between bounded decode slices, even for one large network chunk.
const DECODE_CHUNK_BYTES = 64 * 1024;
const eventSchema = z.looseObject({
  type: z.string().min(1),
  delta: z.string().optional(),
  output_index: z.number().int().min(0).max(1023).optional(),
  item: z.looseObject({ type: z.string().min(1) }).optional(),
  response: z
    .looseObject({
      output: z
        .array(z.looseObject({ type: z.string().min(1) }))
        .max(1024)
        .optional(),
    })
    .optional(),
});
/** Bounded SSE parsing shared by both downstream dialects and nonstream aggregation. */
export async function* xaiEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Wire> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: Wire[] = [];
  function* drainEvents(): Generator<Wire> {
    try {
      for (const event of events) {
        signal?.throwIfAborted();
        yield event;
      }
    } finally {
      events.length = 0;
    }
  }
  const observer = new SseObserver({
    maxEventBytes: MAX_SSE_EVENT_BYTES,
    requireTerminator: true,
    onIssue(issue) {
      let message = "Invalid xAI SSE event";
      if (issue === "sse_event_too_large")
        message = "xAI SSE event exceeds limit";
      else if (issue === "truncated_sse_event")
        message = "Truncated xAI SSE event";
      throw new ProviderRequestError(message, 502);
    },
    onEvent(value) {
      const event = eventSchema.safeParse(value);
      if (!event.success)
        throw new ProviderRequestError("Invalid xAI SSE event", 502);
      events.push(event.data);
    },
  });
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.value) {
        for (
          let offset = 0;
          offset < chunk.value.byteLength;
          offset += DECODE_CHUNK_BYTES
        ) {
          try {
            observer.push(
              decoder.decode(
                chunk.value.subarray(offset, offset + DECODE_CHUNK_BYTES),
                { stream: true },
              ),
            );
          } catch (error) {
            // Deliver earlier complete events before surfacing a later parse failure.
            yield* drainEvents();
            throw error;
          }
          yield* drainEvents();
        }
      }
      if (chunk.done) {
        observer.push(decoder.decode());
        observer.end();
        yield* drainEvents();
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
