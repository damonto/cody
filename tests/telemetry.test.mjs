import assert from "node:assert/strict";
import test from "node:test";
import { RequestMeter } from "../src/telemetry/meter.ts";
import { SseObserver } from "../src/telemetry/stream.ts";

function fixture(protocol = "openai", websocket = false) {
  const events = [];
  let clock = 1000;
  const meter = new RequestMeter({
    requestId: "request",
    endpoint: protocol === "openai" ? "responses" : "messages",
    method: websocket ? "WS" : "POST",
    protocol,
    websocket,
    now: () => clock,
    sink: { send: async (event) => events.push(event) },
  });
  meter.configure({
    revision: 7,
    model_policies: [
      {
        service_id: "a",
        model: "real",
        context_window: 1_000_000,
        pricing: {
          currency: "USD",
          tiers: [
            {
              up_to_input_tokens: null,
              input: "3",
              output: "15",
              cache_write: "3.75",
              cache_read: "0.30",
            },
          ],
        },
      },
    ],
  });
  meter.authenticate("client");
  meter.requestedModel("alias");
  meter.select({ serviceId: "a", keyId: "key", model: "real" });
  return {
    meter,
    events,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("meters reject non-inference requests before sending any usage", async () => {
  const events = [];
  for (const [endpoint, method, websocket = false] of [
    ["models", "GET"],
    ["health", "GET"],
    ["sessions", "DELETE"],
    ["alpha/search", "POST"],
    ["alpha/history/v2/list_windows", "POST"],
    ["alpha/notes/v2/thread_hint", "POST"],
    ["responses", "GET"],
    ["messages", "GET"],
    ["messages", "WS", true],
  ]) {
    assert.throws(
      () =>
        new RequestMeter({
          requestId: "not-inference",
          endpoint,
          method,
          websocket,
          protocol: "openai",
          sink: { send: async (event) => events.push(event) },
        }),
      /Only inference requests can be metered/,
    );
  }
  await Promise.resolve();
  assert.deepEqual(events, []);
});

test("SSE is forwarded byte for byte, including UTF-8 split across chunks", async () => {
  const { meter, events, advance } = fixture();
  const source =
    ': ping\r\n\r\ndata: {"type":"response.reasoning_summary_text.delta","delta":"想"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.completed","response":{"id":"resp","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":400,"cache_write_tokens":100},"output_tokens":50,"output_tokens_details":{"reasoning_tokens":20}}}}\r\n\r\n';
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  const response = meter.response(
    new Response(
      new ReadableStream({
        pull(controller) {
          advance(5);
          if (offset >= bytes.length) controller.close();
          else {
            controller.enqueue(bytes.slice(offset, offset + 7));
            offset += 7;
          }
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "x-upstream": "preserved",
        },
      },
    ),
  );
  assert.equal(response.headers.get("x-upstream"), "preserved");
  assert.equal(await response.text(), source);
  await meter.drain();
  const final = events.at(-1);
  assert.equal(final.usage.tokens.input_tokens, 1000);
  assert.equal(final.usage.tokens.output_tokens, 50);
  assert.equal(final.context_tokens, 1000);
  assert.equal(final.context_window, 1_000_000);
  assert.equal(final.response_id, "resp");
  assert.ok(final.ttft_ms < final.first_text_ms);
  assert.ok(final.first_text_ms < final.duration_ms);
  assert.equal(final.billing.price_version, '[7,"a","real"]');
  assert.equal(final.outcome, "success");
  assert.deepEqual(
    events.map((event) => event.sequence),
    [0, 1, 2],
  );
  assert.ok(events.every((event) => event.kind === "inference"));
});

test("HTTP 200 in-band errors and disconnects have their own terminal outcome", async () => {
  const first = fixture();
  const response = first.meter.response(
    new Response('data: {"type":"error","error":{"code":"overloaded"}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  await response.text();
  await first.meter.drain();
  assert.equal(first.events.at(-1).http_status, 200);
  assert.equal(first.events.at(-1).outcome, "failed");
  const second = fixture();
  let cancelled = false;
  const reader = second.meter
    .response(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(":ping\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    .body.getReader();
  await reader.read();
  await reader.cancel();
  await second.meter.drain();
  assert.equal(cancelled, true);
  assert.equal(second.events.at(-1).outcome, "cancelled");
});

test("nonstream JSON cannot invent a first-token timestamp", async () => {
  const { meter, events } = fixture();
  await meter
    .response(Response.json({ usage: { input_tokens: 20, output_tokens: 3 } }))
    .text();
  await meter.drain();
  assert.equal(events.at(-1).ttft_ms, null);
  assert.equal(events.at(-1).first_text_ms, null);
  assert.equal(events.at(-1).usage.status, "partial");
});

for (const transport of ["sse", "websocket"]) {
  test(`${transport} custom tool input records generation latency without first text`, async () => {
    const { meter, events, advance } = fixture(
      "openai",
      transport === "websocket",
    );
    const frames = [
      { type: "response.created", response: { id: "resp_tool" } },
      {
        type: "response.output_item.added",
        item: { type: "custom_tool_call", name: "exec", input: "" },
      },
      { type: "response.custom_tool_call_input.delta", delta: "" },
      {
        type: "response.custom_tool_call_input.delta",
        delta: "print(",
      },
      { type: "response.custom_tool_call_input.delta", delta: "1)" },
      {
        type: "response.completed",
        response: {
          id: "resp_tool",
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 3,
          },
        },
      },
    ];
    if (transport === "sse") {
      let index = 0;
      const source = frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join("");
      const response = meter.response(
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                advance(100);
                if (index === frames.length) controller.close();
                else {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify(frames[index++])}\n\n`,
                    ),
                  );
                }
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
      assert.equal(await response.text(), source);
    } else {
      for (const frame of frames) {
        advance(100);
        meter.observe(frame);
      }
      meter.finish("success", 200);
    }
    await meter.drain();
    const final = events.at(-1);
    assert.equal(final.ttft_ms, 400);
    assert.equal(final.first_text_ms, null);
    assert.equal(final.outcome, "success");
    assert.equal(final.observation_issue, null);
    assert.equal(final.usage.tokens.output_tokens, 3);
  });
}

test("SSE observation is bounded and recovers at the next event", () => {
  const events = [],
    issues = [];
  const observer = new SseObserver(
    (value) => events.push(value),
    (issue) => issues.push(issue),
    40,
  );
  observer.push('data: "' + "x".repeat(100));
  observer.push('"\n\ndata: {"usage":1}\n\n');
  observer.end();
  assert.deepEqual(events, [{ usage: 1 }]);
  assert.ok(issues.includes("sse_event_too_large"));
});

test("one meter emits a terminal event once and retains request-time pricing", async () => {
  const { meter, events } = fixture();
  meter.observe({
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 2,
    },
  });
  meter.finish("success", 200);
  meter.finish("failed", 500);
  await meter.drain();
  assert.equal(events.filter((event) => event.phase === "finished").length, 1);
  assert.equal(events.at(-1).outcome, "success");
});

test("queue delivery acknowledgement is false when the terminal event is rejected", async () => {
  const meter = new RequestMeter({
    requestId: "rejected",
    endpoint: "responses",
    method: "POST",
    protocol: "openai",
    sink: {
      send: async (event) => {
        if (event.phase === "finished") throw new Error("queue unavailable");
      },
    },
  });
  meter.finish("success", 200);
  assert.equal(await meter.drain(), false);
});

test("a truncated successful SSE response is incomplete and CR-only lines are parsed", async () => {
  const { meter, events } = fixture();
  await meter
    .response(
      new Response(
        'data: {"type":"response.output_text.delta","delta":"text"}\r\r',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    .text();
  await meter.drain();
  assert.equal(events.at(-1).outcome, "incomplete");
  assert.equal(
    events.at(-1).observation_issue,
    "stream_ended_without_completion",
  );
  assert.notEqual(events.at(-1).first_text_ms, null);
  const complete = fixture();
  await complete.meter
    .response(
      new Response(
        'data: {"choices":[{"delta":{"content":"text"}}]}\r\rdata: [DONE]\r\r',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    .text();
  await complete.meter.drain();
  assert.equal(complete.events.at(-1).outcome, "success");
});

test("configured retry responses contribute separately priced usage without reading the final response", async () => {
  const { retryResponseUsage } = await import("../src/telemetry/retry.ts");
  const previous = await retryResponseUsage(
    Response.json(
      {
        usage: {
          input_tokens: 200000,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 0,
        },
      },
      { status: 503 },
    ),
    "openai",
  );
  const { meter, events } = fixture();
  meter.recordAttempts([
    { attempt: 1, status: 503, duration_ms: 30, usage: previous },
    { attempt: 2, status: 200, duration_ms: 50 },
  ]);
  await meter
    .response(
      Response.json({
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 10,
        },
      }),
    )
    .text();
  await meter.drain();
  const event = events.at(-1);
  assert.equal(event.usage.tokens.input_tokens, 201000);
  assert.equal(event.context_tokens, 1000);
  assert.equal(event.attempts[0].billing.total_nano, 600000000);
  assert.equal(event.billing.total_nano, 603150000);
  assert.equal(event.billing.status, "complete");
  assert.equal(
    await retryResponseUsage(
      new Response("x".repeat(100000), {
        headers: { "content-type": "application/json" },
      }),
      "openai",
    ),
    null,
  );
});

for (const transport of ["http", "sse", "websocket"]) {
  test(`${transport} meters apply cache write pricing to each attempt's usage`, async () => {
    const { retryResponseUsage } = await import("../src/telemetry/retry.ts");
    const previous = await retryResponseUsage(
      Response.json({
        usage: {
          input_tokens: 200_000,
          output_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
        },
      }),
      "openai",
    );
    assert.equal(previous.status, "partial");
    const events = [];
    const meter = new RequestMeter({
      requestId: "omitted-cache-writes",
      endpoint: "responses",
      method: transport === "websocket" ? "WS" : "POST",
      protocol: "openai",
      websocket: transport === "websocket",
      sink: { send: async (event) => events.push(event) },
    });
    const config = {
      revision: 7,
      model_policies: [
        {
          service_id: "a",
          model: "gemini-3.8-flash",
          context_window: 1_000_000,
          pricing: {
            currency: "USD",
            tiers: [
              {
                up_to_input_tokens: 200_000,
                input: "0.75",
                output: "3.75",
                cache_write: "0",
                cache_read: "0.075",
              },
              {
                up_to_input_tokens: null,
                input: "1.50",
                output: "7.50",
                cache_write: "1.875",
                cache_read: "0.15",
              },
            ],
          },
        },
      ],
    };
    meter.configure(config);
    meter.authenticate("client");
    meter.select({ serviceId: "a", keyId: "key", model: "gemini-3.8-flash" });
    config.model_policies[0].pricing.tiers[0].cache_write = "0.9375";
    meter.recordAttempts([
      { attempt: 1, status: 503, duration_ms: 30, usage: previous },
      { attempt: 2, status: 200, duration_ms: 50 },
    ]);
    const response = {
      id: "response",
      model: "gemini-3.8-flash",
      usage: {
        input_tokens: 14_436,
        output_tokens: 5,
        total_tokens: 14_441,
        input_tokens_details: { cached_tokens: 0 },
      },
    };
    const frame = { type: "response.completed", response };
    if (transport === "websocket") {
      meter.observe(frame);
      assert.equal(meter.checkpoint().usage.status, "reported");
      meter.finish("success", 200);
    } else {
      const source =
        transport === "sse"
          ? `data: ${JSON.stringify(frame)}\n\n`
          : JSON.stringify(response);
      const forwarded = meter.response(
        new Response(source, {
          headers: {
            "content-type":
              transport === "sse" ? "text/event-stream" : "application/json",
          },
        }),
      );
      assert.equal(await forwarded.text(), source);
    }
    await meter.drain();
    const event = events.at(-1);
    assert.equal(event.outcome, "success");
    assert.equal(event.observation_issue, null);
    assert.equal(event.context_tokens, 14_436);
    assert.equal(event.usage.tokens.input_tokens, 214_436);
    assert.equal(event.usage.tokens.uncached_input_tokens, 214_436);
    assert.equal(event.usage.tokens.cache_write_tokens, 0);
    assert.equal(event.usage.status, "reported");
    assert.equal(event.billing.status, "complete");
    assert.equal(event.billing.total_nano, 160_845_750);
    assert.deepEqual(
      event.attempts.map((attempt) => attempt.billing.total_nano),
      [150_000_000, 10_845_750],
    );
    assert.ok(
      event.attempts.every((attempt) => attempt.usage.status === "reported"),
    );
    assert.deepEqual(event.usage.raw, response.usage);
    assert.equal(previous.status, "partial");
  });
}
