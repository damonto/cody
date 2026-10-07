import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fetchWithConfiguredRetries } from "../src/gateway/http/upstream-retry.ts";
import { inspectRetryError } from "../src/gateway/http/retry-errors.ts";
import { retryResponseUsage } from "../src/telemetry/retry.ts";
import { RequestMeter } from "../src/telemetry/meter.ts";
import { MAX_RETRY_RESPONSE_BYTES } from "../src/shared/response-limits.ts";

const policy = {
  status_codes: [429],
  error_codes: ["rate_limit_exceeded"],
  delays_ms: [100, 200],
};
const makeRequest = (signal) =>
  new Request("https://upstream.example/responses", {
    method: "POST",
    headers: { authorization: "Bearer same-credential" },
    body: '{"model":"gpt-6-astra","input":"hello"}',
    signal,
  });
const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const failed = {
  type: "response.failed",
  response: {
    id: "resp_failed",
    status: "failed",
    output: [],
    error: { code: "rate_limit_exceeded", message: "Please retry" },
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};
const preamble = event({ type: "response.created", response: { output: [] } });
const sse = (body) =>
  new Response(body, {
    headers: { "content-type": "text/event-stream", "x-upstream": "preserved" },
  });
const emptyMessage = {
  type: "message",
  id: "msg_empty",
  role: "assistant",
  status: "in_progress",
  content: [],
};
const emptyReasoning = { type: "reasoning", id: "rs_empty", summary: [] };
const emptyText = {
  type: "output_text",
  text: "",
  annotations: [],
  logprobs: [],
};

test("empty Responses lifecycle and placeholder events allow configured retries", async () => {
  const prefixes = [
    ...["response.created", "response.in_progress"].flatMap((type) =>
      [undefined, null, []].map((output) =>
        event({ type, response: { status: "in_progress", output } }),
      ),
    ),
    preamble +
      event({ type: "response.output_item.added", item: emptyMessage }),
    preamble +
      event({ type: "response.output_item.added", item: emptyReasoning }),
    preamble + event({ type: "response.content_part.added", part: emptyText }),
    preamble +
      event({
        type: "response.content_part.added",
        part: { type: "refusal", refusal: "" },
      }),
    preamble +
      event({
        type: "response.reasoning_summary_part.added",
        part: { type: "summary_text", text: "" },
      }),
  ];
  for (const prefix of prefixes) {
    const body = prefix + event(failed);
    for (const splitChunks of [false, true]) {
      let calls = 0;
      const result = await fetchWithConfiguredRetries(makeRequest, policy, {
        send: async () => {
          calls++;
          const chunks = splitChunks ? [prefix, event(failed)] : [body];
          return sse(
            new ReadableStream({
              pull(controller) {
                const chunk = chunks.shift();
                if (chunk === undefined) controller.close();
                else controller.enqueue(new TextEncoder().encode(chunk));
              },
            }),
          );
        },
        wait: async () => {},
      });
      assert.equal(calls, 3, prefix);
      assert.equal(result.attempts[0].error, "rate_limit_exceeded");
      assert.equal(await result.response.text(), body);
    }
  }
});

test("empty output snapshots on failed responses do not count as generated content", async () => {
  for (const output of [
    [emptyMessage],
    [emptyReasoning],
    [{ ...emptyMessage, content: [emptyText] }],
    [
      {
        ...emptyReasoning,
        summary: [{ type: "summary_text", text: "" }],
        encrypted_content: null,
      },
    ],
  ]) {
    const payload = { ...failed, response: { ...failed.response, output } };
    for (const response of [
      Response.json(payload),
      sse(preamble + event(payload)),
    ]) {
      const inspected = await inspectRetryError(
        response,
        new AbortController().signal,
        policy.error_codes,
      );
      assert.equal(inspected.errorCode, "rate_limit_exceeded");
      await inspected.response.body.cancel();
    }
  }
});

test("large Responses metadata allows error-code retries and retains discarded usage", async () => {
  const metadata = {
    instructions: "private instructions ".repeat(5000),
    tools: [
      { type: "function", name: "example", description: "x".repeat(80 * 1024) },
    ],
  };
  const failure = {
    ...failed,
    response: { ...metadata, ...failed.response },
  };
  for (const format of ["sse", "json"]) {
    const body =
      format === "sse"
        ? event({
            type: "response.created",
            response: { ...metadata, status: "in_progress", output: [] },
          }) +
          event({
            type: "response.in_progress",
            response: { ...metadata, status: "in_progress", output: [] },
          }) +
          event(failure)
        : JSON.stringify(failure);
    const success = {
      type: "response.completed",
      response: { id: "done", output: [] },
    };
    const finalBody =
      format === "sse" ? event(success) : JSON.stringify(success);
    for (const chunkSize of [16384, Infinity]) {
      let calls = 0;
      const result = await fetchWithConfiguredRetries(makeRequest, policy, {
        send: async () => {
          calls++;
          const bytes = new TextEncoder().encode(
            calls === 1 ? body : finalBody,
          );
          let offset = 0;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (offset === bytes.length) return controller.close();
                const end = Math.min(bytes.length, offset + chunkSize);
                controller.enqueue(bytes.subarray(offset, end));
                offset = end;
              },
            }),
            {
              headers: {
                "content-type":
                  format === "sse" ? "text/event-stream" : "application/json",
              },
            },
          );
        },
        wait: async () => {},
        observeDiscardedResponse: (response) =>
          retryResponseUsage(response, "openai"),
      });
      assert.equal(calls, 2, `${format}, chunk size ${chunkSize}`);
      assert.equal(
        result.attempts[0].retry_diagnostic.reason,
        "error_code_match",
      );
      assert.equal(result.attempts[0].status, 200);
      assert.equal(result.attempts[0].usage.tokens.input_tokens, 10);
      assert.equal(await result.response.text(), finalBody);
    }
  }
});

test("output following large lifecycle metadata still prevents replay", async () => {
  const prefix = event({
    type: "response.created",
    response: {
      instructions: "x".repeat(100 * 1024),
      status: "in_progress",
      output: [],
    },
  });
  const body =
    prefix +
    event({ type: "response.output_text.delta", delta: "hello" }) +
    event(failed);
  let calls = 0;
  const result = await fetchWithConfiguredRetries(makeRequest, policy, {
    send: async () => {
      calls++;
      return sse(body);
    },
    wait: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts[0].retry_diagnostic.reason, "output_observed");
  assert.equal(await result.response.text(), body);
});

test("successful output after empty placeholders is forwarded byte for byte without replay", async () => {
  const prefix =
    preamble +
    event({ type: "response.output_item.added", item: emptyMessage }) +
    event({ type: "response.content_part.added", part: emptyText });
  const delta = event({ type: "response.output_text.delta", delta: "hello" });
  let source;
  let calls = 0;
  const response = sse(
    new ReadableStream({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode(prefix + delta));
      },
    }),
  );
  const result = await fetchWithConfiguredRetries(makeRequest, policy, {
    send: async () => {
      calls++;
      return response;
    },
    wait: async () => {},
  });
  // An error arriving after output was committed cannot restart the request.
  source.enqueue(new TextEncoder().encode(event(failed)));
  source.close();
  assert.equal(calls, 1);
  assert.equal(await result.response.text(), prefix + delta + event(failed));
});

test("content, tools and unrecognized placeholder fields always end inspection", async () => {
  const unsafeItems = [
    { ...emptyMessage, content: [{ ...emptyText, text: "hello" }] },
    { ...emptyMessage, content: [{ type: "refusal", refusal: "No" }] },
    { ...emptyMessage, role: "user" },
    { ...emptyMessage, status: "completed" },
    { ...emptyMessage, audio: "opaque" },
    {
      ...emptyReasoning,
      summary: [{ type: "summary_text", text: "thinking" }],
    },
    {
      ...emptyReasoning,
      content: [{ type: "reasoning_text", text: "thinking" }],
    },
    { ...emptyReasoning, encrypted_content: "opaque" },
    { ...emptyReasoning, text: "unknown content field" },
    { type: "function_call", name: "write_file", arguments: "" },
    { type: "web_search_call", status: "in_progress" },
    { type: "unknown" },
  ];
  const firstEvents = [
    ...unsafeItems.map((item) => ({
      type: "response.output_item.added",
      item,
    })),
    ...unsafeItems.map((item) => ({
      ...failed,
      response: { ...failed.response, output: [item] },
    })),
    {
      type: "response.content_part.added",
      part: { ...emptyText, text: "hello" },
    },
    {
      type: "response.content_part.added",
      part: { ...emptyText, annotations: [{ type: "url_citation" }] },
    },
    {
      type: "response.reasoning_summary_part.added",
      part: { type: "summary_text", text: "thinking" },
    },
    { type: "response.output_item.added", item: { type: "message" } },
    {
      type: "response.output_item.added",
      item: emptyMessage,
      status: "completed",
    },
    {
      type: "response.output_item.added",
      item: emptyMessage,
      error: { code: "other" },
    },
    { type: "response.created" },
    { type: "response.completed", response: { output: [emptyMessage] } },
    { type: "response.output_text.delta", delta: "" },
  ];
  for (const first of firstEvents) {
    let calls = 0;
    const body = preamble + event(first) + event(failed);
    const result = await fetchWithConfiguredRetries(makeRequest, policy, {
      send: async () => {
        calls++;
        return sse(body);
      },
      wait: async () => {},
    });
    assert.equal(calls, 1, JSON.stringify(first));
    assert.equal(await result.response.text(), body);
  }
});

test("HTTP and SSE errors share retries, authentication, raw statuses and usage", async () => {
  const requests = [];
  const waits = [];
  const responses = [
    new Response("limited", { status: 429 }),
    sse(preamble + event(failed)),
    sse(event({ type: "response.completed", response: { id: "resp_ok" } })),
  ];
  const result = await fetchWithConfiguredRetries(makeRequest, policy, {
    send: async (request) => {
      requests.push({
        url: request.url,
        headers: [...request.headers],
        body: await request.text(),
      });
      return responses[requests.length - 1];
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    observeDiscardedResponse: (response) =>
      retryResponseUsage(response, "openai"),
  });
  assert.deepEqual(waits, [100, 200]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1], requests[2]);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.status),
    [429, 200, 200],
  );
  assert.equal(result.attempts[1].error, "rate_limit_exceeded");
  assert.equal(result.attempts[1].usage.tokens.input_tokens, 10);
  assert.equal(result.response.headers.get("x-upstream"), "preserved");
  assert.equal(
    await result.response.text(),
    event({ type: "response.completed", response: { id: "resp_ok" } }),
  );
});

test("error-code retries are opt-in, bounded and return the final error unchanged", async () => {
  for (const retry of [
    undefined,
    { status_codes: [429], delays_ms: [0] },
    policy,
  ]) {
    let count = 0;
    const result = await fetchWithConfiguredRetries(makeRequest, retry, {
      send: async () => {
        count++;
        return sse(event(failed));
      },
      wait: async () => {},
    });
    assert.equal(count, retry === policy ? 3 : 1);
    assert.equal(result.response.status, 200);
    assert.equal(await result.response.text(), event(failed));
  }
});

test("structured JSON and SSE error shapes match without searching message text", async () => {
  const shapes = [
    { error: { code: "rate_limit_exceeded" } },
    { error: { type: "rate_limit_exceeded" } },
    {
      object: "response",
      status: "failed",
      error: { code: "rate_limit_exceeded" },
    },
    failed,
    { type: "custom.event", error: { code: "rate_limit_exceeded" } },
    { type: "custom.failure", response: failed.response },
    { type: "response.provider_failure", response: failed.response },
    { type: "error", code: "rate_limit_exceeded" },
  ];
  for (const payload of shapes) {
    for (const response of [Response.json(payload), sse(event(payload))]) {
      const inspected = await inspectRetryError(
        response,
        new AbortController().signal,
        policy.error_codes,
      );
      assert.equal(inspected.errorCode, "rate_limit_exceeded");
      await inspected.response.body.cancel();
    }
  }
  for (const payload of [
    { text: "rate_limit_exceeded" },
    { error: { code: "other_error", message: "rate_limit_exceeded" } },
    { code: "rate_limit_exceeded" },
    { error: { code: "other_error", type: "rate_limit_exceeded" } },
    {
      ...failed,
      response: { ...failed.response, output: [{ type: "function_call" }] },
    },
  ]) {
    const response = Response.json(payload);
    const inspected = await inspectRetryError(
      response,
      new AbortController().signal,
      policy.error_codes,
    );
    assert.equal(inspected.errorCode, undefined);
    assert.deepEqual(await inspected.response.json(), payload);
  }
});

test("split UTF-8, CRLF and multiline SSE preserve original bytes", async () => {
  const text =
    ': 心跳\r\n\r\nevent: error\r\ndata: {"code":\r\ndata: "rate_limit_exceeded"}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const response = sse(
    new ReadableStream({
      pull(controller) {
        if (i === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(i, ++i));
      },
    }),
  );
  const inspected = await inspectRetryError(
    response,
    new AbortController().signal,
    policy.error_codes,
  );
  assert.equal(inspected.errorCode, "rate_limit_exceeded");
  assert.equal(await inspected.response.text(), text);
});

test("output, tools, unknown events and malformed data prohibit later replay", async () => {
  const firstEvents = [
    event({ type: "response.output_text.delta", delta: "hello" }),
    event({
      type: "response.output_item.added",
      item: { type: "function_call" },
    }),
    event({
      type: "response.created",
      response: { output: [{ type: "message" }] },
    }),
    event({ type: "unknown" }),
    "data: invalid JSON\n\n",
    "data: [DONE]\n\n",
  ];
  for (const first of firstEvents) {
    let count = 0;
    const body = preamble + first + event(failed);
    const result = await fetchWithConfiguredRetries(makeRequest, policy, {
      send: async () => {
        count++;
        return sse(body);
      },
      wait: async () => {},
    });
    assert.equal(count, 1);
    assert.equal(await result.response.text(), body);
  }
});

test("native terminal errors take precedence over error-code retries", async () => {
  let count = 0;
  const upstream = Response.json({ error: { code: "rate_limit_exceeded" } });
  const result = await fetchWithConfiguredRetries(makeRequest, policy, {
    send: async () => {
      count++;
      return upstream;
    },
    isTerminal: () => true,
  });
  assert.equal(count, 1);
  assert.equal(result.response, upstream);
  assert.equal(upstream.bodyUsed, false);
  await upstream.body.cancel();
});

test("error-shaped fields in output or successful events never authorize replay", async () => {
  for (const payload of [
    {
      type: "response.output_text.delta",
      delta: "hello",
      error: { code: "rate_limit_exceeded" },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [],
        error: { code: "rate_limit_exceeded" },
      },
    },
    {
      object: "response",
      status: "completed",
      output: [],
      error: { code: "rate_limit_exceeded" },
    },
    { ...failed, response: { ...failed.response, output: "malformed output" } },
    { ...failed, status: "completed" },
    { type: "response.created", status: "completed", response: { output: [] } },
  ]) {
    for (const response of [Response.json(payload), sse(event(payload))]) {
      const inspected = await inspectRetryError(
        response,
        new AbortController().signal,
        policy.error_codes,
      );
      assert.equal(inspected.errorCode, undefined, JSON.stringify(payload));
      await inspected.response.body.cancel();
    }
  }
});

test("body inspection requires an exact JSON or SSE media type", async () => {
  for (const contentType of [
    "text/plain; description=json",
    "application/notjson",
    "text/event-stream-fake",
  ]) {
    const response = new Response(JSON.stringify(failed), {
      headers: { "content-type": contentType },
    });
    const inspected = await inspectRetryError(
      response,
      new AbortController().signal,
      policy.error_codes,
    );
    assert.equal(inspected.response, response);
    assert.equal(response.bodyUsed, false);
    assert.equal(await retryResponseUsage(response, "openai"), null);
    await response.body.cancel();
  }
});

test("JSON suffix media types remain supported with parameters", async () => {
  const response = new Response(JSON.stringify(failed), {
    headers: { "content-type": "Application/Problem+Json; charset=utf-8" },
  });
  const inspected = await inspectRetryError(
    response,
    new AbortController().signal,
    policy.error_codes,
  );
  assert.equal(inspected.errorCode, "rate_limit_exceeded");
  assert.equal(
    (await retryResponseUsage(inspected.response, "openai")).tokens
      .input_tokens,
    10,
  );
});

test("conflicting SSE event and payload types do not authorize retries", async () => {
  const body = `event: response.completed\n${event(failed)}`;
  const inspected = await inspectRetryError(
    sse(body),
    new AbortController().signal,
    policy.error_codes,
  );
  assert.equal(inspected.errorCode, undefined);
  assert.equal(await inspected.response.text(), body);
});

test("an exhausted inspection budget leaves the response untouched", async () => {
  const response = sse(event(failed));
  const inspected = await inspectRetryError(
    response,
    new AbortController().signal,
    policy.error_codes,
    0,
  );
  assert.equal(inspected.response, response);
  assert.equal(inspected.errorCode, undefined);
  assert.equal(response.bodyUsed, false);
  await response.body.cancel();
});

test("attempt callback failures release the response without becoming transport errors", async () => {
  for (const callback of ["onResponse", "isTerminal"]) {
    let cancelled = false;
    await assert.rejects(
      fetchWithConfiguredRetries(makeRequest, policy, {
        send: async () =>
          sse(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
        [callback]: () => {
          throw new Error("callback failed");
        },
      }),
      /callback failed/,
    );
    assert.equal(cancelled, true);
  }
});

test("WebSocket handshakes and unknown content types bypass body inspection", async () => {
  for (const upgrade of [true, false]) {
    const upstream = new Response(
      JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
      {
        headers: {
          "content-type": upgrade ? "application/json" : "text/plain",
        },
      },
    );
    const result = await fetchWithConfiguredRetries(
      () => {
        const request = makeRequest();
        if (upgrade) request.headers.set("upgrade", "websocket");
        return request;
      },
      policy,
      { send: async () => upstream },
    );
    assert.equal(result.response, upstream);
    assert.equal(result.attempts.length, 1);
    await upstream.body.cancel();
  }
});

test("size boundary replays every byte and never classifies later errors", async () => {
  const body =
    ":" + "x".repeat(MAX_RETRY_RESPONSE_BYTES + 1024) + "\n\n" + event(failed);
  const inspected = await inspectRetryError(
    sse(body),
    new AbortController().signal,
    policy.error_codes,
  );
  assert.equal(inspected.errorCode, undefined);
  assert.equal(inspected.diagnostic.reason, "inspection_limit");
  assert.equal(await inspected.response.text(), body);
  assert.equal(inspected.errorCode, undefined);
});

test("discarded usage remains bounded when a response exceeds the retry prefix limit", async () => {
  const body =
    ":" + "x".repeat(MAX_RETRY_RESPONSE_BYTES + 1024) + "\n\n" + event(failed);
  assert.equal(await retryResponseUsage(sse(body), "openai"), null);
});

test(
  "inspection timeout commits preamble and preserves a pending upstream read",
  { timeout: 1000 },
  async () => {
    let source;
    const response = sse(
      new ReadableStream({
        start(controller) {
          source = controller;
          controller.enqueue(new TextEncoder().encode(preamble));
        },
      }),
    );
    const inspected = await inspectRetryError(
      response,
      new AbortController().signal,
      policy.error_codes,
      5,
    );
    assert.equal(inspected.errorCode, undefined);
    assert.equal(inspected.diagnostic.reason, "inspection_timeout");
    source.enqueue(new TextEncoder().encode(event(failed)));
    source.close();
    assert.equal(await inspected.response.text(), preamble + event(failed));
    assert.equal(inspected.errorCode, undefined);
    assert.equal(inspected.diagnostic.reason, "inspection_timeout");
  },
);

test("client cancellation during inspection cancels the stream without retrying", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let count = 0;
  const resultPromise = fetchWithConfiguredRetries(
    () => makeRequest(controller.signal),
    policy,
    {
      send: async () => {
        count++;
        return sse(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    },
  );
  await setImmediate();
  controller.abort(new Error("client disconnected"));
  const result = await resultPromise;
  assert.equal(result.error.message, "client disconnected");
  assert.equal(result.response, undefined);
  assert.equal(count, 1);
  assert.equal(cancelled, true);
});

test(
  "shared deadline bounds inspection instead of waiting ten seconds",
  { timeout: 1000 },
  async () => {
    let cancelled = false;
    const result = await fetchWithConfiguredRetries(makeRequest, policy, {
      deadline: Date.now() + 20,
      send: async () =>
        sse(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    assert.equal(result.attempts.length, 1);
    assert.equal(result.response.status, 200);
    await result.response.body.cancel();
    assert.equal(cancelled, true);
  },
);

test("custom error envelopes use configured retries without an error event name", async () => {
  for (const code of ["rate_limit_exceeded", "DeploymentNotFound"]) {
    let calls = 0;
    const result = await fetchWithConfiguredRetries(
      makeRequest,
      {
        status_codes: [400, 429, 500, 503],
        error_codes: ["rate_limit_exceeded", "DeploymentNotFound"],
        delays_ms: [100, 300],
      },
      {
        send: async () => {
          calls++;
          return calls === 1
            ? sse(
                preamble + event({ type: "provider.failure", error: { code } }),
              )
            : sse(
                event({ type: "response.completed", response: { output: [] } }),
              );
        },
        wait: async () => {},
      },
    );
    assert.equal(calls, 2);
    assert.equal(result.attempts[0].error, code);
    assert.equal(result.attempts[0].retry_delay_ms, 100);
    assert.equal(result.attempts[0].status, 200);
    await result.response.text();
  }
});

test("custom errors carrying output cannot authorize replay", async () => {
  for (const output of [
    { delta: "hello" },
    { choices: [{ delta: { tool_calls: [{ index: 0 }] } }] },
    { item: { type: "function_call", arguments: "" } },
    { content: "hello" },
  ]) {
    const body = event({
      type: "custom",
      error: { code: "rate_limit_exceeded" },
      ...output,
    });
    const inspected = await inspectRetryError(
      sse(body),
      new AbortController().signal,
      policy.error_codes,
    );
    assert.equal(inspected.errorCode, undefined);
    assert.equal(await inspected.response.text(), body);
  }
});

test("content in lifecycle preambles and nested envelopes prevents retry", async () => {
  for (const first of [
    { type: "response.created", response: { output: [] }, delta: "hello" },
    {
      type: "response.in_progress",
      response: { output: [], content: "hello" },
    },
    {
      type: "provider.failure",
      response: { ...failed.response, delta: "hello" },
    },
    {
      type: "response.mcp_list_tools.in_progress",
      error: failed.response.error,
    },
  ]) {
    let calls = 0;
    const body = event(first) + event(failed);
    const result = await fetchWithConfiguredRetries(makeRequest, policy, {
      send: async () => {
        calls++;
        return sse(body);
      },
      wait: async () => {},
    });
    assert.equal(calls, 1, JSON.stringify(first));
    assert.equal(await result.response.text(), body);
  }
});

test("a valid error code is not rejected because of an unrelated error type", async () => {
  const body = event({
    type: "provider.failure",
    error: { code: "rate_limit_exceeded", type: 123 },
  });
  const inspected = await inspectRetryError(
    sse(body),
    new AbortController().signal,
    policy.error_codes,
  );
  assert.equal(inspected.errorCode, "rate_limit_exceeded");
  assert.equal(await inspected.response.text(), body);
});

test("late SSE diagnostics retain the event that prevented configured retries", async () => {
  for (const [first, reason] of [
    [{ type: "response.output_text.delta", delta: "" }, "output_observed"],
    [{ type: "provider.heartbeat" }, "unrecognized_event"],
    [
      { type: "response.completed", response: { output: [] } },
      "terminal_event",
    ],
  ]) {
    let calls = 0;
    const body = preamble + event(first) + event(failed);
    const result = await fetchWithConfiguredRetries(makeRequest, policy, {
      send: async () => {
        calls++;
        return sse(body);
      },
      wait: async () => {},
    });
    const meter = new RequestMeter({
      requestId: "retry-diagnostic",
      endpoint: "responses",
      method: "POST",
      protocol: "openai",
      sink: { send: async () => {} },
    });
    meter.recordAttempts(result.attempts);
    assert.equal(await meter.response(result.response).text(), body);
    const recorded = meter.checkpoint();
    assert.equal(calls, 1);
    assert.equal(recorded.http_status, 200);
    assert.equal(recorded.outcome, "failed");
    assert.equal(recorded.diagnostic_code, "rate_limit_exceeded");
    assert.equal(recorded.observation_issue, null);
    assert.deepEqual(recorded.attempts[0].retry_diagnostic, {
      reason,
      event_type: first.type,
    });
    await meter.drain();
  }
});

test("retry diagnostics distinguish matching errors, exhausted policies and missing policies", async () => {
  for (const [retry, expected] of [
    [undefined, ["policy_disabled"]],
    [{ status_codes: [429], delays_ms: [0] }, ["status_not_matched"]],
    [policy, ["error_code_match", "error_code_match", "attempts_exhausted"]],
  ]) {
    const result = await fetchWithConfiguredRetries(makeRequest, retry, {
      send: async () => sse(preamble + event(failed)),
      wait: async () => {},
    });
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.retry_diagnostic.reason),
      expected,
    );
    if (retry === policy)
      assert.deepEqual(result.attempts[0].retry_diagnostic, {
        reason: "error_code_match",
        event_type: "response.failed",
        error_code: "rate_limit_exceeded",
      });
    assert.equal(await result.response.text(), preamble + event(failed));
  }
});
