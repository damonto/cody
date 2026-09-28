import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fetchWithConfiguredRetries } from "../src/gateway/http/upstream-retry.ts";
import { inspectRetryError } from "../src/gateway/http/retry-errors.ts";
import { retryResponseUsage } from "../src/telemetry/retry.ts";

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

test("error-shaped fields in unknown or successful events never authorize replay", async () => {
  for (const payload of [
    { type: "custom.event", error: { code: "rate_limit_exceeded" } },
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
  const body = ":" + "x".repeat(70 * 1024) + "\n\n" + event(failed);
  const inspected = await inspectRetryError(
    sse(body),
    new AbortController().signal,
    policy.error_codes,
  );
  assert.equal(inspected.errorCode, undefined);
  assert.equal(await inspected.response.text(), body);
  assert.equal(inspected.errorCode, undefined);
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
    source.enqueue(new TextEncoder().encode(event(failed)));
    source.close();
    assert.equal(await inspected.response.text(), preamble + event(failed));
    assert.equal(inspected.errorCode, undefined);
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
