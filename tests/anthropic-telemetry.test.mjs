import assert from "node:assert/strict";
import test from "node:test";
import { RequestMeter } from "../src/telemetry/meter.ts";

function fixture() {
  let clock = 1000;
  const events = [];
  const meter = new RequestMeter({
    requestId: "anthropic-request",
    endpoint: "messages",
    method: "POST",
    protocol: "anthropic",
    now: () => clock,
    sink: { send: async (event) => events.push(event) },
  });
  meter.authenticate("client");
  meter.select({
    serviceId: "anthropic",
    keyId: "primary",
    model: "claude-test",
  });
  return {
    meter,
    events,
    advance: () => {
      clock += 100;
    },
  };
}

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [],
    stop_reason: null,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 1,
    },
  },
};
const start = (index, content_block) => ({
  type: "content_block_start",
  index,
  content_block,
});
const delta = (index, value) => ({
  type: "content_block_delta",
  index,
  delta: value,
});
const stop = (index) => ({ type: "content_block_stop", index });
const finish = (stop_reason = "end_turn", output_tokens = 5) => [
  {
    type: "message_delta",
    delta: { stop_reason, stop_sequence: null },
    usage: { output_tokens },
  },
  { type: "message_stop" },
];
const tool = (type, input = {}) => ({
  type,
  id: "tool_test",
  name: "search",
  ...(type === "mcp_tool_use" ? { server_name: "docs" } : {}),
  input,
});

async function stream(frames, chunkSize) {
  const { meter, events, advance } = fixture();
  const encoded = frames.map((frame) =>
    typeof frame === "string"
      ? frame
      : `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
  );
  const bytes = new TextEncoder().encode(encoded.join(""));
  const chunks = chunkSize
    ? Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, i) =>
        bytes.slice(i * chunkSize, (i + 1) * chunkSize),
      )
    : encoded.map((frame) => new TextEncoder().encode(frame));
  let index = 0;
  const source = new ReadableStream(
    {
      pull(controller) {
        advance();
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
    },
    { highWaterMark: 0 },
  );
  const response = meter.response(
    new Response(source, {
      headers: {
        "content-type": "text/event-stream",
        "x-upstream": "preserved",
      },
    }),
  );
  assert.equal(response.headers.get("x-upstream"), "preserved");
  assert.equal(await response.text(), encoded.join(""));
  await meter.drain();
  return events.at(-1);
}

test("Anthropic thinking precedes text, while message usage remains cumulative", async () => {
  const frames = [
    messageStart,
    { type: "ping" },
    start(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "考虑" }),
    delta(0, { type: "signature_delta", signature: "opaque-signature" }),
    stop(0),
    start(1, { type: "text", text: "" }),
    delta(1, { type: "text_delta", text: "你好" }),
    delta(1, {
      type: "citations_delta",
      citation: { cited_text: "source text" },
    }),
    stop(1),
    ...finish(),
  ];
  for (const chunkSize of [undefined, 7]) {
    const result = await stream(frames, chunkSize);
    assert.equal(result.protocol, "anthropic");
    assert.equal(result.transport, "sse");
    assert.equal(result.outcome, "success");
    assert.equal(result.observation_issue, null);
    assert.ok(result.ttft_ms < result.first_text_ms);
    assert.ok(result.first_text_ms < result.duration_ms);
    if (!chunkSize) {
      assert.equal(result.ttft_ms, 400);
      assert.equal(result.first_text_ms, 800);
    }
    assert.equal(result.usage.status, "reported");
    assert.equal(result.usage.tokens.input_tokens, 60);
    assert.equal(result.usage.tokens.uncached_input_tokens, 10);
    assert.equal(result.usage.tokens.cache_write_tokens, 20);
    assert.equal(result.usage.tokens.cache_read_tokens, 30);
    assert.equal(result.usage.tokens.output_tokens, 5);
    assert.equal(result.usage.tokens.reasoning_tokens, null);
  }
});

for (const type of ["tool_use", "server_tool_use", "mcp_tool_use"]) {
  test(`Anthropic ${type} records streamed and prefilled inputs without first text`, async () => {
    for (const prefilled of [false, true]) {
      const frames = [
        messageStart,
        start(0, tool(type, prefilled ? { query: "test" } : {})),
        ...(prefilled
          ? []
          : [
              delta(0, { type: "input_json_delta", partial_json: '{"query":' }),
              delta(0, { type: "input_json_delta", partial_json: '"test"}' }),
            ]),
        stop(0),
        ...finish("tool_use", 25),
      ];
      const result = await stream(frames);
      assert.equal(result.ttft_ms, prefilled ? 200 : 300);
      assert.equal(result.first_text_ms, null);
      assert.equal(result.outcome, "success");
      assert.equal(result.observation_issue, null);
      assert.equal(result.usage.tokens.output_tokens, 25);
    }
  });
}

test("Anthropic compaction summaries record generation before the actual reply", async () => {
  for (const prefilled of [false, true]) {
    const frames = [
      messageStart,
      start(0, {
        type: "compaction",
        content: prefilled ? "Context summary" : null,
      }),
      ...(prefilled
        ? []
        : [
            delta(0, {
              type: "compaction_delta",
              content: "Context summary",
              encrypted_content: "opaque",
            }),
          ]),
      stop(0),
      start(1, { type: "text", text: "" }),
      delta(1, { type: "text_delta", text: "The reply" }),
      stop(1),
      ...finish(),
    ];
    const result = await stream(frames);
    assert.equal(result.ttft_ms, prefilled ? 200 : 300);
    assert.equal(result.first_text_ms, prefilled ? 500 : 600);
    assert.equal(result.outcome, "success");
  }
});

test("Anthropic redacted thinking is generated content, while signatures and failed compaction are not", async () => {
  const ignored = [
    messageStart,
    start(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "signature_delta", signature: "opaque" }),
    stop(0),
    start(1, { type: "compaction", content: null }),
    delta(1, {
      type: "compaction_delta",
      content: null,
      encrypted_content: "opaque-metadata",
    }),
    stop(1),
  ];
  const result = await stream([
    ...ignored,
    start(2, { type: "redacted_thinking", data: "opaque-thinking" }),
    stop(2),
    ...finish(),
  ]);
  assert.equal(result.ttft_ms, 800);
  assert.equal(result.first_text_ms, null);
  const withoutContent = await stream([...ignored, ...finish()]);
  assert.equal(withoutContent.ttft_ms, null);
  assert.equal(withoutContent.first_text_ms, null);
});

test("Anthropic tool results and fallback boundaries do not become reply text", async () => {
  const resultBlocks = [
    {
      type: "mcp_tool_result",
      tool_use_id: "tool_previous",
      is_error: false,
      content: [{ type: "text", text: "MCP result" }],
    },
    {
      type: "web_search_tool_result",
      tool_use_id: "tool_previous",
      content: [
        {
          type: "web_search_result",
          title: "Search result",
          encrypted_content: "opaque",
        },
      ],
    },
    {
      type: "code_execution_tool_result",
      tool_use_id: "tool_previous",
      content: {
        type: "code_execution_result",
        stdout: "Program output",
        stderr: "",
        return_code: 0,
      },
    },
    { type: "fallback", from: { model: "previous" }, to: { model: "next" } },
    { type: "container_upload", file_id: "file_test" },
  ];
  const prefix = [
    messageStart,
    ...resultBlocks.flatMap((block, index) => [
      start(index, block),
      stop(index),
    ]),
  ];
  const noReply = await stream([...prefix, ...finish()]);
  assert.equal(noReply.ttft_ms, null);
  assert.equal(noReply.first_text_ms, null);
  const withReply = await stream([
    ...prefix,
    start(5, { type: "text", text: "" }),
    delta(5, { type: "text_delta", text: "The actual reply" }),
    stop(5),
    ...finish(),
  ]);
  assert.equal(withReply.ttft_ms, 1300);
  assert.equal(withReply.first_text_ms, 1300);
});

test("Anthropic refusals and empty end_turn responses time only actual text", async () => {
  for (const reason of ["refusal", "end_turn"]) {
    const endings = [
      {
        type: "message_delta",
        delta: {
          stop_reason: reason,
          stop_details: { explanation: "Metadata is not reply text" },
        },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    const empty = await stream([messageStart, ...endings]);
    assert.equal(empty.outcome, "success");
    assert.equal(empty.ttft_ms, null);
    assert.equal(empty.first_text_ms, null);
    const text = await stream([
      messageStart,
      start(0, { type: "text", text: "" }),
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"No"}}\n\n',
      stop(0),
      ...endings,
    ]);
    assert.equal(text.ttft_ms, 300);
    assert.equal(text.first_text_ms, 300);
  }
});

test("Anthropic in-band errors and truncated streams preserve observed timing", async () => {
  const prefix = [
    messageStart,
    start(0, { type: "text", text: "" }),
    delta(0, { type: "text_delta", text: "Partial" }),
  ];
  const failed = await stream([
    ...prefix,
    {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    },
  ]);
  assert.equal(failed.http_status, 200);
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.first_text_ms, 300);
  const truncated = await stream(prefix);
  assert.equal(truncated.outcome, "incomplete");
  assert.equal(truncated.observation_issue, "stream_ended_without_completion");
  assert.equal(truncated.first_text_ms, 300);
});

test("Anthropic nonstream messages retain usage and do not report streaming latency", async () => {
  const { meter, events, advance } = fixture();
  const message = {
    ...messageStart.message,
    content: [{ type: "text", text: "The reply" }],
    stop_reason: "end_turn",
  };
  advance();
  assert.equal(
    await meter.response(Response.json(message)).text(),
    JSON.stringify(message),
  );
  await meter.drain();
  const result = events.at(-1);
  assert.equal(result.transport, "http");
  assert.equal(result.outcome, "success");
  assert.equal(result.ttft_ms, null);
  assert.equal(result.first_text_ms, null);
  assert.equal(result.usage.tokens.input_tokens, 60);
  assert.equal(result.usage.status, "reported");
});
