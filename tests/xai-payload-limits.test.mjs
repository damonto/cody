import assert from "node:assert/strict";
import test from "node:test";
import { xaiEvents } from "../src/providers/xai/sse.ts";
import { ResponseEncoder } from "../src/providers/xai/response-encoder.ts";
import {
  MAX_SSE_EVENT_BYTES,
  MAX_XAI_REPLAY_CIPHERTEXT_BYTES,
  MAX_XAI_REPLAY_ENVELOPE_BYTES,
} from "../src/shared/payload-limits.ts";
import { openReasoning, sealReasoning } from "../src/providers/xai/replay.ts";
import { encryptConfig } from "../src/control/crypto.ts";

const encoder = new TextEncoder();

function source(bytes, chunkSize = bytes.length, cancelled = () => {}) {
  let offset = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        offset = Math.min(bytes.length, offset + chunkSize);
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
}

async function consume(stream) {
  let count = 0;
  for await (const _event of xaiEvents(stream)) count++;
  return count;
}

test("xAI SSE accepts multiple large events in a single network chunk", async () => {
  const data = JSON.stringify({
    type: "metadata",
    value: "x".repeat(9 * 1024 * 1024),
  });
  const bytes = encoder.encode(`data: ${data}\n\ndata: ${data}\n\n`);
  for (const chunkSize of [65537, bytes.length])
    assert.equal(await consume(source(bytes, chunkSize)), 2);
});

test("xAI SSE enforces UTF-8 event bytes at the boundary across chunk layouts", async () => {
  const overhead = encoder.encode(
    JSON.stringify({ type: "metadata", value: "" }),
  ).length;
  const budget = MAX_SSE_EVENT_BYTES - overhead;
  const value = "界".repeat(Math.floor(budget / 3)) + "x".repeat(budget % 3);
  for (const extra of [0, 1]) {
    const data = JSON.stringify({
      type: "metadata",
      value: value + "x".repeat(extra),
    });
    assert.equal(encoder.encode(data).length, MAX_SSE_EVENT_BYTES + extra);
    const bytes = encoder.encode(`data: ${data}\r\n\r\n`);
    for (const chunkSize of [65537, bytes.length]) {
      let cancelled = false;
      const pending = consume(
        source(bytes, chunkSize, () => {
          cancelled = true;
        }),
      );
      if (extra) {
        await assert.rejects(pending, /SSE event exceeds limit/);
        assert.equal(cancelled, true);
      } else assert.equal(await pending, 1);
    }
  }
});

test("xAI SSE preserves Unicode and multiline events with fragmented CRLF", async () => {
  const bytes = encoder.encode(
    ': ping\r\nevent: metadata\r\ndata: {"type":"metadata",\r\ndata: "value":"界😀"}\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  for (const chunkSize of [1, 7, bytes.length]) {
    const events = [];
    for await (const event of xaiEvents(source(bytes, chunkSize)))
      events.push(event);
    assert.deepEqual(events, [{ type: "metadata", value: "界😀" }]);
  }
});

test("xAI SSE rejects an unterminated final event and cancels on early return", async () => {
  await assert.rejects(
    consume(source(encoder.encode('data: {"type":"metadata"}\n'))),
    /Truncated xAI SSE event/,
  );
  let cancelled = false;
  const bytes = encoder.encode('data: {"type":"metadata"}\n\n'.repeat(2));
  for await (const _event of xaiEvents(
    source(bytes, bytes.length, () => {
      cancelled = true;
    }),
  ))
    break;
  assert.equal(cancelled, true);
});

test("xAI cumulative output counts UTF-8 bytes independently of the SSE event budget", async () => {
  const output = new ResponseEncoder({
    anthropic: false,
    stream: true,
    model: "grok",
    tools: [],
  });
  const event = { type: "metadata", value: "界".repeat(2 * 1024 * 1024) };
  for (let i = 0; i < 5; i++) await output.accept(event);
  await assert.rejects(output.accept(event), /xAI output exceeds limit/);
});

test("xAI SSE delivers the same valid prefix before a malformed event across chunk layouts", async () => {
  const bytes = encoder.encode(
    'data: {"type":"metadata","value":"界😀"}\n\ndata: invalid\n\n',
  );
  for (const chunkSize of [1, bytes.length]) {
    const events = [];
    await assert.rejects(async () => {
      for await (const event of xaiEvents(source(bytes, chunkSize)))
        events.push(event);
    }, /Invalid xAI SSE event/);
    assert.deepEqual(events, [{ type: "metadata", value: "界😀" }]);
  }
});

test("xAI SSE cancellation stops events already parsed from the same network chunk", async () => {
  const signal = new AbortController();
  let cancelled = false;
  const bytes = encoder.encode('data: {"type":"metadata"}\n\n'.repeat(2));
  const events = xaiEvents(
    source(bytes, bytes.length, () => {
      cancelled = true;
    }),
    signal.signal,
  );
  assert.deepEqual((await events.next()).value, { type: "metadata" });
  const reason = new Error("client disconnected");
  signal.abort(reason);
  await assert.rejects(events.next(), (error) => error === reason);
  assert.equal(cancelled, true);
});

test("xAI replay opening enforces the same ciphertext budget as sealing", async () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const scope = {
    client_id: "client",
    provider_id: "xai",
    account_ref: crypto.randomUUID(),
    model: "grok",
  };
  const item = {
    type: "reasoning",
    encrypted_content: "x".repeat(6 * 1024 * 1024),
  };
  const encrypted = await encryptConfig(
    { purpose: "xai-replay", scope, item, visible: "" },
    key,
  );
  const envelope = "cody-xai1." + btoa(encrypted);
  assert.ok(encrypted.length > MAX_XAI_REPLAY_CIPHERTEXT_BYTES);
  assert.ok(envelope.length < MAX_XAI_REPLAY_ENVELOPE_BYTES);
  await assert.rejects(sealReasoning(item, "", scope, key), /replay limit/);
  await assert.rejects(
    openReasoning(envelope, "", scope, key, [scope.account_ref]),
    { code: "invalid_thinking_signature" },
  );
});
