import assert from "node:assert/strict";
import test from "node:test";
import { inspectResponsePrefix } from "../src/gateway/http/response-prefix.ts";

const bytes = (value) => new TextEncoder().encode(value);
const inspection = (observe) => ({ maxBytes: 1024, timeoutMs: 10, observe });

test("zero preflight budget observes only downstream reads and preserves backpressure", async () => {
  let reads = 0;
  const seen = [];
  const source = new Response(
    new ReadableStream(
      {
        pull(controller) {
          reads++;
          controller.enqueue(bytes("forwarded"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const { response, stoppedBy } = await inspectResponsePrefix(
    source,
    new AbortController().signal,
    {
      maxBytes: 1024,
      timeoutMs: 0,
      observe: async (chunk) => {
        seen.push(chunk ? new TextDecoder().decode(chunk) : null);
        return true;
      },
    },
  );
  assert.equal(stoppedBy, "timeout");
  assert.equal(reads, 0);
  assert.deepEqual(seen, []);
  assert.equal(await response.text(), "forwarded");
  assert.equal(reads, 1);
  assert.deepEqual(seen, ["forwarded", null]);
  assert.equal(source.body.locked, false);
});

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
  const { response, stoppedBy } = await pending;
  assert.equal(stoppedBy, "timeout");
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
    const { response } = await inspectResponsePrefix(
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
  const { response } = await inspectResponsePrefix(
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

test("a decisive observation at the byte boundary takes precedence over the size limit", async () => {
  const { response, stoppedBy } = await inspectResponsePrefix(
    new Response("limit"),
    new AbortController().signal,
    { maxBytes: 5, timeoutMs: 1000, observe: async () => true },
  );
  assert.equal(stoppedBy, "observer");
  assert.equal(await response.text(), "limit");
});

test("small transport chunks are coalesced without changing bytes, observation or backpressure", async () => {
  const input = bytes("α".repeat(1024) + "tail");
  const seen = [];
  let offset = 0;
  let pulls = 0;
  const source = new Response(
    new ReadableStream(
      {
        pull(controller) {
          pulls++;
          const end = offset < 1024 ? offset + 1 : input.length;
          controller.enqueue(input.subarray(offset, end));
          offset = end;
          if (offset === input.length) controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const { response, stoppedBy } = await inspectResponsePrefix(
    source,
    new AbortController().signal,
    {
      maxBytes: 1536,
      timeoutMs: 10_000,
      observe: async (chunk) => {
        if (chunk) seen.push(...chunk);
        return false;
      },
    },
  );
  assert.equal(stoppedBy, "size");
  assert.equal(pulls, 1025);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, input.subarray(0, 1536));
  assert.equal(pulls, 1025);
  assert.deepEqual((await reader.read()).value, input.subarray(1536));
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(new Uint8Array(seen), input);
  assert.equal(source.body.locked, false);
});

test("fully observed streams report EOF and reject invalid limits before locking", async () => {
  const { response, stoppedBy } = await inspectResponsePrefix(
    new Response("complete"),
    new AbortController().signal,
    { maxBytes: 100, timeoutMs: 1000, observe: async () => false },
  );
  assert.equal(stoppedBy, "eof");
  assert.equal(await response.text(), "complete");
  for (const invalid of [
    { maxBytes: 0 },
    { maxBytes: Infinity },
    { maxBytes: 1.5 },
    { timeoutMs: -1 },
    { timeoutMs: NaN },
  ]) {
    const source = new Response("unread");
    await assert.rejects(
      inspectResponsePrefix(source, new AbortController().signal, {
        ...inspection(async () => false),
        ...invalid,
      }),
      RangeError,
    );
    assert.equal(source.body.locked, false);
    assert.equal(await source.text(), "unread");
  }
});
