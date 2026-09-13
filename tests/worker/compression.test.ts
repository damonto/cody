import { expect, test, vi } from "vitest";
import { decodeResponseBody } from "../../src/gateway/transport/compression.ts";

test("Workers Brotli errors cancel the source even while it awaits another chunk", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([255, 255, 255, 255]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const body = decodeResponseBody(
    source,
    new Headers({ "content-encoding": "br" }),
  );
  await expect(new Response(body).text()).rejects.toThrow();
  await vi.waitFor(() => expect(cancelled).toBe(true));
});

test("Workers Brotli output cancellation propagates to an idle source", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const body = decodeResponseBody(
    source,
    new Headers({ "content-encoding": "br" }),
  );
  await body.cancel();
  await vi.waitFor(() => expect(cancelled).toBe(true));
});
