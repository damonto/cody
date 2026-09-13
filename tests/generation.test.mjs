import assert from "node:assert/strict";
import test from "node:test";
import { RequestMeter } from "../src/telemetry/meter.ts";

const message = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Hello" }],
};
const completed = { type: "response.completed", response: { output: [] } };
const itemEvent = (item, type = "response.output_item.done") => ({
  type,
  item,
});

async function observe(frames, transport = "sse", protocol = "openai") {
  const events = [];
  let clock = 1000;
  const meter = new RequestMeter({
    requestId: "generation",
    endpoint: protocol === "anthropic" ? "messages" : "responses",
    method: transport === "websocket" ? "WS" : "POST",
    websocket: transport === "websocket",
    protocol,
    now: () => clock,
    sink: { send: async (event) => events.push(event) },
  });
  if (transport === "websocket") {
    for (const frame of frames) {
      clock += 100;
      meter.observe(frame);
    }
    meter.finish("success", 200);
  } else if (transport === "http") {
    clock += 100;
    const source = JSON.stringify(frames[0]);
    assert.equal(
      await meter
        .response(
          new Response(source, {
            headers: { "content-type": "application/json" },
          }),
        )
        .text(),
      source,
    );
  } else {
    const chunks = frames.map((frame) =>
      typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`,
    );
    let index = 0;
    const source = new ReadableStream(
      {
        pull(controller) {
          clock += 100;
          if (index === chunks.length) controller.close();
          else controller.enqueue(new TextEncoder().encode(chunks[index++]));
        },
      },
      { highWaterMark: 0 },
    );
    assert.equal(
      await meter
        .response(
          new Response(source, {
            headers: { "content-type": "text/event-stream" },
          }),
        )
        .text(),
      chunks.join(""),
    );
  }
  await meter.drain();
  const result = events.at(-1);
  assert.equal(result.observation_issue, null);
  return result;
}

const textEvents = [
  { type: "response.output_text.delta", delta: "Hello" },
  { type: "response.refusal.delta", delta: "I cannot help with that." },
  { type: "response.output_text.done", text: "Hello" },
  { type: "response.refusal.done", refusal: "I cannot help with that." },
  { type: "response.audio.transcript.delta", delta: "Hello" },
  { type: "response.content_part.added", part: message.content[0] },
  {
    type: "response.content_part.done",
    part: { type: "refusal", refusal: "No" },
  },
  itemEvent(message, "response.output_item.added"),
  itemEvent(message),
  { type: "response.completed", response: { output: [message] } },
  { type: "response.incomplete", response: { output: [message] } },
  { type: "response.failed", response: { output: [message] } },
  { choices: [{ delta: { refusal: "No" } }] },
  { choices: [{ message: { role: "assistant", content: "Hello" } }] },
];
const generatedEvents = [
  ...[
    "reasoning_text",
    "reasoning_summary_text",
    "function_call_arguments",
    "custom_tool_call_input",
    "mcp_call_arguments",
    "code_interpreter_call_code",
    "shell_call_command",
    "audio",
  ].map((name) => ({ type: `response.${name}.delta`, delta: "generated" })),
  { type: "response.reasoning_text.done", text: "A thought" },
  { type: "response.reasoning_summary_text.done", text: "A summary" },
  {
    type: "response.reasoning_summary_part.added",
    part: { type: "summary_text", text: "A summary" },
  },
  {
    type: "response.reasoning_summary_part.done",
    part: { type: "summary_text", text: "A summary" },
  },
  { type: "response.function_call_arguments.done", arguments: "{}" },
  { type: "response.custom_tool_call_input.done", input: "print(1)" },
  { type: "response.mcp_call_arguments.done", arguments: '{"query":"test"}' },
  { type: "response.code_interpreter_call_code.done", code: "print(1)" },
  { type: "response.shell_call_command.added", command: "pwd" },
  { type: "response.shell_call_command.done", command: "pwd" },
  {
    type: "response.image_generation_call.partial_image",
    partial_image_b64: "AQID",
  },
  ...[
    { type: "reasoning", summary: [], encrypted_content: "opaque" },
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "A thought" }],
    },
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "A thought" }],
    },
    { type: "function_call", arguments: "{}" },
    { type: "custom_tool_call", input: "print(1)" },
    { type: "mcp_call", arguments: "{}" },
    { type: "mcp_approval_request", arguments: "{}" },
    { type: "code_interpreter_call", code: "print(1)" },
    { type: "image_generation_call", result: "AQID" },
    { type: "file_search_call", queries: ["query"] },
    { type: "web_search_call", action: { type: "search", queries: ["query"] } },
    {
      type: "web_search_call",
      action: { type: "open_page", url: "https://example.com" },
    },
    { type: "shell_call", action: { commands: ["pwd"] } },
    { type: "local_shell_call", action: { type: "exec", command: ["pwd"] } },
    { type: "computer_call", action: { type: "screenshot" } },
    { type: "computer_call", actions: [{ type: "click", x: 10, y: 20 }] },
    {
      type: "apply_patch_call",
      operation: { type: "delete_file", path: "example.txt" },
    },
  ].map((item) => itemEvent(item)),
  { choices: [{ delta: { function_call: { arguments: "{}" } } }] },
  { choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }] },
  { choices: [{ delta: { reasoning_content: "A thought" } }] },
];

for (const transport of ["sse", "websocket"]) {
  for (const { label, examples } of [
    { label: "text", examples: textEvents },
    { label: "generation", examples: generatedEvents },
  ]) {
    test(`${transport} records the first observed ${label} across supported output events`, async () => {
      for (const example of examples) {
        const result = await observe(
          [
            { type: "response.created", response: { output: [] } },
            example,
            example,
            completed,
          ],
          transport,
        );
        const description = JSON.stringify(example);
        assert.equal(result.ttft_ms, 200, description);
        assert.equal(
          result.first_text_ms,
          label === "text" ? 200 : null,
          description,
        );
      }
    });
  }

  test(`${transport} records complete reasoning before tool input and later text`, async () => {
    const result = await observe(
      [
        itemEvent(
          { type: "reasoning", encrypted_content: "", summary: [] },
          "response.output_item.added",
        ),
        itemEvent({
          type: "reasoning",
          encrypted_content: "opaque",
          summary: [],
        }),
        { type: "response.mcp_call_arguments.delta", delta: "{}" },
        { type: "response.output_text.delta", delta: "Hello" },
        itemEvent(message),
        { type: "response.completed", response: { output: [message] } },
      ],
      transport,
    );
    assert.equal(result.ttft_ms, 200);
    assert.equal(result.first_text_ms, 400);
  });
}

test("Anthropic content blocks distinguish text, thinking and prefilled tool input", async () => {
  const examples = [
    [{ type: "text", text: "Hello" }, true],
    [{ type: "thinking", thinking: "A thought" }, false],
    [{ type: "redacted_thinking", data: "opaque" }, false],
    [{ type: "tool_use", input: { query: "test" } }, false],
    [{ type: "server_tool_use", input: { query: "test" } }, false],
  ];
  for (const [content_block, text] of examples) {
    const result = await observe(
      [
        { type: "message_start", message: { content: [] } },
        { type: "content_block_start", index: 0, content_block },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ],
      "sse",
      "anthropic",
    );
    assert.equal(result.ttft_ms, 200, content_block.type);
    assert.equal(result.first_text_ms, text ? 200 : null, content_block.type);
  }
  const result = await observe(
    [
      {
        type: "content_block_start",
        content_block: { type: "tool_use", input: {} },
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "A thought" },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "message_stop" },
    ],
    "sse",
    "anthropic",
  );
  assert.equal(result.ttft_ms, 200);
  assert.equal(result.first_text_ms, 400);
});

test("SSE event names work when the JSON payload omits type", async () => {
  const result = await observe([
    ": ping\n\n",
    'event: response.refusal.delta\ndata: {"delta":"No"}\n\n',
    completed,
  ]);
  assert.equal(result.ttft_ms, 200);
  assert.equal(result.first_text_ms, 200);
});

test("status, empty placeholders, signatures and tool results cannot start generation timing", async () => {
  const frames = [
    { type: "response.created", response: { output: [message] } },
    { type: "response.in_progress" },
    { type: "response.mcp_list_tools.completed" },
    { type: "response.web_search_call.searching" },
    { type: "response.image_generation_call.generating" },
    { type: "response.audio.done" },
    { type: "response.audio.transcript.done" },
    {
      type: "response.output_text.annotation.added",
      annotation: { title: "Citation" },
    },
    { type: "response.unknown.delta", delta: "metadata" },
    { type: "response.reasoning_metadata.delta", delta: "metadata" },
    { type: "response.refusal.delta", delta: "" },
    { type: "response.audio.delta", delta: null },
    { type: "response.mcp_call_arguments.delta", delta: {} },
    {
      type: "response.image_generation_call.partial_image",
      partial_image_b64: "",
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "" },
    },
    itemEvent(
      { type: "message", role: "assistant", content: [] },
      "response.output_item.added",
    ),
    itemEvent({ type: "message", role: "user", content: message.content }),
    itemEvent({ type: "reasoning", summary: [], encrypted_content: "" }),
    itemEvent({ type: "custom_tool_call", name: "exec", input: "" }),
    itemEvent({ type: "function_call", name: "tool", arguments: "" }),
    itemEvent({ type: "shell_call", action: { commands: [] } }),
    itemEvent({ type: "computer_call", actions: [] }),
    itemEvent({ type: "function_call_output", output: "tool result" }),
    itemEvent({
      type: "shell_call_output",
      output: [{ stdout: "tool result" }],
    }),
    itemEvent({ type: "mcp_list_tools", tools: [{ name: "tool" }] }),
    {
      type: "response.shell_call_output_content.delta",
      delta: { stdout: "tool result" },
    },
    {
      type: "content_block_start",
      content_block: { type: "tool_use", input: {} },
    },
    {
      type: "content_block_start",
      content_block: { type: "thinking", thinking: "", signature: "opaque" },
    },
    {
      type: "content_block_start",
      content_block: { type: "tool_result", content: "tool result" },
    },
    {
      type: "content_block_delta",
      delta: { type: "signature_delta", signature: "opaque" },
    },
    {
      type: "content_block_delta",
      delta: { type: "citations_delta", citation: { cited_text: "Citation" } },
    },
    { choices: [{ delta: { role: "assistant", content: "" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ function: { name: "tool", arguments: "" } }],
          },
        },
      ],
    },
    { choices: [{ message: { role: "tool", content: "tool result" } }] },
    {
      type: "response.completed",
      response: { output: [], usage: { output_tokens: 20 } },
    },
  ];
  for (const transport of ["sse", "websocket"]) {
    const result = await observe(frames, transport);
    assert.equal(result.ttft_ms, null, transport);
    assert.equal(result.first_text_ms, null, transport);
    assert.equal(result.usage.tokens.output_tokens, 20);
  }
});

test("nonstream JSON reports usage without inventing timing even for event-shaped output", async () => {
  const usage = { input_tokens: 20, output_tokens: 3 };
  for (const payload of [
    { object: "response", output: [message], usage },
    { type: "response.completed", response: { output: [message], usage } },
    { type: "response.output_text.delta", delta: "Hello", usage },
    { choices: [{ message: { role: "assistant", content: "Hello" } }], usage },
    { type: "message", content: [{ type: "text", text: "Hello" }], usage },
  ]) {
    const result = await observe([payload], "http");
    assert.equal(result.first_response_ms, null);
    assert.equal(result.ttft_ms, null);
    assert.equal(result.first_text_ms, null);
    assert.equal(result.usage.tokens.output_tokens, 3);
  }
});
