import assert from "node:assert/strict";
import test from "node:test";
import { inspectResponsePrefix } from "../src/gateway/http/response-prefix.ts";

const bytes = (value) => new TextEncoder().encode(value);
const inspection = (observe) => ({ maxBytes: 1024, timeoutMs: 10, observe });

test("downstream cancellation releases a pending read handed off by preflight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled;
  const source = new Response(
    new ReadableStream({
      cancel(reason) {
        cancelled = reason;
      },
    }),
  );
  const pending = inspectResponsePrefix(
    source,
    new AbortController().signal,
    inspection(async () => false),
  );
  t.mock.timers.tick(10);
  const response = await pending;
  const reader = response.body.getReader();
  const read = reader.read();
  await reader.cancel("client disconnected");
  assert.deepEqual(await read, { done: true, value: undefined });
  assert.equal(cancelled, "client disconnected");
  assert.equal(source.body.locked, false);
});

test(
  "abort during asynchronous observation rejects the pending downstream read",
  { timeout: 1000 },
  async () => {
    const abort = new AbortController();
    let observed = 0;
    let cancelled = false;
    const source = new Response(
      new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(bytes("chunk"));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
    const response = await inspectResponsePrefix(
      source,
      abort.signal,
      inspection(async () => {
        if (++observed === 2)
          abort.abort(new Error("cancelled during observation"));
        return true;
      }),
    );
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    await assert.rejects(reader.read(), /cancelled during observation/);
    assert.equal(cancelled, true);
    assert.equal(source.body.locked, false);
  },
);

test("forwarding preserves backpressure and releases an errored upstream reader", async () => {
  let reads = 0;
  const source = new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (++reads === 1) controller.enqueue(bytes("prefix"));
          else controller.error(new Error("upstream disconnected"));
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const response = await inspectResponsePrefix(
    source,
    new AbortController().signal,
    inspection(async () => true),
  );
  assert.equal(reads, 1);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes("prefix"));
  assert.equal(reads, 1);
  await assert.rejects(reader.read(), /upstream disconnected/);
  // Cleanup follows the rejected read in the forwarding pull.
  await reader.cancel().catch(() => {});
  assert.equal(source.body.locked, false);
});

test("a failed prefix observer cancels and releases the upstream reader", async () => {
  let cancelled;
  const source = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes("prefix"));
      },
      cancel(reason) {
        cancelled = reason;
      },
    }),
  );
  const error = new Error("quota observation failed");
  await assert.rejects(
    inspectResponsePrefix(
      source,
      new AbortController().signal,
      inspection(async () => {
        throw error;
      }),
    ),
    error,
  );
  assert.equal(cancelled, error);
  assert.equal(source.body.locked, false);
});

test("abort during prefix observation never hands out a cancelled response", async () => {
  const abort = new AbortController();
  const source = new Response("prefix");
  await assert.rejects(
    inspectResponsePrefix(
      source,
      abort.signal,
      inspection(async () => {
        abort.abort(new Error("cancelled during prefix"));
        return true;
      }),
    ),
    /cancelled during prefix/,
  );
  assert.equal(source.body.locked, false);
});
