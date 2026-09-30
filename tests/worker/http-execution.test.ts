import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import worker from "../../src/worker.ts";
import { RequestMeter } from "../../src/telemetry/meter.ts";
import {
  parseConfig,
  clearConfigCacheForTests,
} from "../../src/config/store.ts";
import {
  httpExecutionEndpoint,
  INFERENCE_PATHS,
  inferenceAliases,
  CONTEXT_MANAGEMENT_PATHS,
} from "../../src/gateway/protocol.ts";

beforeAll(async () => {
  const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  clearConfigCacheForTests();
  await env.CODY_CONFIG_KV.put(
    env.CONFIG_KEY,
    JSON.stringify(
      parseConfig({
        providers: [
          {
            type: "ai_gateway",
            id: "primary",
            base_url: "https://upstream.test/v1",
            models: ["model"],
            priority: 100,
            disabled: false,
            credentials: [
              {
                id: "key",
                priority: 100,
                disabled: false,
                auth: { type: "api_key", api_key: "upstream-secret" },
              },
            ],
          },
        ],
        api_keys: [
          { id: "client", api_key: "client-secret", providers: ["primary"] },
        ],
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(
  path = "/responses",
  body = '{ "model": "model", "input": "hello" }',
) {
  return new Request(`https://gateway.test${path}`, {
    method: "POST",
    headers: {
      "x-api-key": "client-secret",
      "content-type": "application/json",
      "x-custom": "preserved",
    },
    body,
  });
}
async function dispatch(input: Request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(input, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

test("dispatch boundary includes registered HTTP routes and excludes other requests", () => {
  for (const path of INFERENCE_PATHS) {
    for (const alias of inferenceAliases(path))
      expect(httpExecutionEndpoint(request(alias))).toBe(path);
  }
  for (const path of CONTEXT_MANAGEMENT_PATHS) {
    for (const alias of [`/${path}`, `/v1/${path}`])
      expect(httpExecutionEndpoint(request(alias))).toBe(path);
  }
  for (const path of [
    "/models",
    "/health",
    "/console/api/config",
    "/messages",
    "/responses/unknown",
  ]) {
    expect(httpExecutionEndpoint(request(path))).toBeUndefined();
  }
  expect(
    httpExecutionEndpoint(
      new Request("https://gateway.test/responses", {
        headers: { upgrade: "websocket" },
      }),
    ),
  ).toBeUndefined();
});

test("real execution DO authenticates and preserves raw request, query and upstream response", async () => {
  const metering = vi.spyOn(RequestMeter.prototype, "response");
  const body = '{ "model": "model", "input": "hello", "extra": [1, 2] }';
  const upstream = vi.fn(async (input: Request) => {
    expect(input.url).toBe("https://upstream.test/v1/responses?custom=1");
    expect(await input.text()).toBe(body);
    expect(input.headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(input.headers.has("x-api-key")).toBe(false);
    expect(input.headers.get("x-custom")).toBe("preserved");
    return new Response(
      '{"id":"answer","usage":{"input_tokens":3,"output_tokens":2}}',
      {
        status: 201,
        headers: { "content-type": "application/json", "x-upstream": "yes" },
      },
    );
  });
  vi.stubGlobal("fetch", upstream);
  const response = await dispatch(request("/responses?custom=1", body));
  expect(response.status).toBe(201);
  expect(response.headers.get("x-upstream")).toBe("yes");
  expect(await response.json()).toMatchObject({ id: "answer" });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(metering).toHaveBeenCalledTimes(1);
  const meter = metering.mock.contexts[0];
  if (!(meter instanceof RequestMeter))
    throw new Error("Missing request meter");
  expect(await meter.drain()).toBe(true);
  expect(meter.checkpoint()).toMatchObject({
    outcome: "success",
    usage: { tokens: { input_tokens: 3, output_tokens: 2 } },
  });
});

test("real execution DO rejects invalid credentials with the request dialect", async () => {
  const upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
  const input = request("/v1/messages");
  input.headers.set("x-api-key", "invalid");
  const response = await dispatch(input);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    type: "error",
    error: { type: "authentication_error" },
  });
  expect(upstream).not.toHaveBeenCalled();
});

test("SSE crosses the DO boundary before completion and cancellation reaches upstream", async () => {
  let cancelled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      let timer: ReturnType<typeof setInterval>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
            ),
          );
          // Create and drive the upstream stream in the execution object's context.
          timer = setInterval(
            () =>
              controller.enqueue(new TextEncoder().encode("data: next\n\n")),
            10,
          );
        },
        cancel() {
          clearInterval(timer);
          cancelled = true;
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
  const abort = new AbortController();
  const response = await dispatch(
    new Request(request("/chat/completions"), { signal: abort.signal }),
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "hello",
  );
  abort.abort();
  await reader.cancel();
  await expect.poll(() => cancelled).toBe(true);
});

test("dispatch failure does not replay upstream and preserves Anthropic errors", async () => {
  const upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
  vi.spyOn(env.HTTP_EXECUTION, "get").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const response = await dispatch(request("/v1/messages"));
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    type: "error",
    error: { type: "api_error" },
  });
  expect(upstream).not.toHaveBeenCalled();
});

test("a failed dispatch cancels the active executor through a fresh stub without replay", async () => {
  let cancelled = false;
  const upstream = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (!cancelled)
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", upstream);
  const id = env.HTTP_EXECUTION.newUniqueId();
  const stub = env.HTTP_EXECUTION.get(id);
  const fetch = stub.fetch.bind(stub);
  const get = env.HTTP_EXECUTION.get.bind(env.HTTP_EXECUTION);
  vi.spyOn(env.HTTP_EXECUTION, "newUniqueId").mockReturnValue(id);
  const getStub = vi
    .spyOn(env.HTTP_EXECUTION, "get")
    .mockImplementation(get)
    .mockReturnValueOnce(stub);
  vi.spyOn(stub, "cancel").mockRejectedValue(new Error("Broken stub"));
  let orphanedResponse: Response | undefined;
  vi.spyOn(stub, "fetch").mockImplementation(async (input, init) => {
    orphanedResponse = await fetch(input, init);
    throw new Error("Dispatch connection lost after upstream started");
  });
  try {
    const response = await dispatch(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "execution_unavailable" },
    });
    expect(cancelled).toBe(true);
    expect(getStub).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledTimes(1);
  } finally {
    await orphanedResponse?.body?.cancel().catch(() => {});
  }
});

test.each(["/responses", "/v1/messages"])(
  "one executor rejects a second request for %s",
  async (path) => {
    const upstream = vi.fn(async () =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    vi.stubGlobal("fetch", upstream);
    const stub = env.HTTP_EXECUTION.get(env.HTTP_EXECUTION.newUniqueId());
    const first = stub.fetch(request(path));
    const second = await stub.fetch(request(path));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject(
      path === "/responses"
        ? { error: { code: "execution_already_started" } }
        : { type: "error", error: { type: "api_error" } },
    );
    expect(await (await first).json()).toMatchObject({
      usage: { input_tokens: 1 },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  },
);

test("disconnect before upstream headers aborts the one attempt", async () => {
  let started = false;
  let cancelled = false;
  const upstream = vi.fn(
    (input: Request) =>
      new Promise<Response>((_resolve, reject) => {
        started = true;
        input.signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(input.signal.reason);
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", upstream);
  const abort = new AbortController();
  const response = dispatch(
    new Request(request("/chat/completions"), { signal: abort.signal }),
  );
  await expect.poll(() => started).toBe(true);
  abort.abort();
  await expect.poll(() => cancelled).toBe(true);
  const result = await response;
  expect(result.status).toBe(499);
  await result.body?.cancel();
  expect(upstream).toHaveBeenCalledTimes(1);
});

test("disconnect drains cancelled usage even while the client stops reading", async () => {
  const metering = vi.spyOn(RequestMeter.prototype, "response");
  let cancelled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              controller.enqueue(
                new TextEncoder().encode(":" + " ".repeat(64 * 1024) + "\n\n"),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
  const abort = new AbortController();
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(request(), { signal: abort.signal }),
    env,
    ctx,
  );
  const meter = metering.mock.contexts[0];
  if (!(meter instanceof RequestMeter))
    throw new Error("Missing request meter");
  abort.abort();
  let drained = false;
  const pending = waitOnExecutionContext(ctx).then(() => {
    drained = true;
  });
  try {
    await expect.poll(() => cancelled).toBe(true);
    await expect.poll(() => drained, { timeout: 1000 }).toBe(true);
    expect(meter.checkpoint()).toMatchObject({
      phase: "finished",
      outcome: "cancelled",
    });
    expect(await meter.drain()).toBe(true);
  } finally {
    await response.body?.cancel().catch(() => {});
    await pending;
  }
});

test("a request cancelled before dispatch never calls upstream", async () => {
  const upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
  const abort = new AbortController();
  abort.abort();
  const response = await dispatch(
    new Request(request(), { signal: abort.signal }),
  );
  expect(response.status).toBe(499);
  await response.body?.cancel();
  expect(upstream).not.toHaveBeenCalled();
});

test("upstream stream errors remain errors across the execution boundary", async () => {
  const metering = vi.spyOn(RequestMeter.prototype, "response");
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setInterval(() => {
                if (fail) {
                  clearInterval(timer);
                  controller.error(new Error("Upstream disconnected"));
                }
              }, 5);
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
  const response = await dispatch(request());
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "hello",
  );
  const rejected = expect(reader.read()).rejects.toThrow();
  fail = true;
  await rejected;
  const meter = metering.mock.contexts[0];
  if (!(meter instanceof RequestMeter))
    throw new Error("Missing request meter");
  expect(await meter.drain()).toBe(true);
  expect(meter.checkpoint()).toMatchObject({
    outcome: "failed",
    observation_issue: "upstream_stream_read_failed",
  });
  reader.releaseLock();
});

test("concurrent requests have independent executors and cancellation", async () => {
  const started = new Set<string>();
  const cancelled = new Set<string>();
  let completeSecond = false;
  const upstream = vi.fn(
    (input: Request) =>
      new Promise<Response>((resolve, reject) => {
        const id = input.headers.get("x-custom")!;
        started.add(id);
        const timer = setInterval(() => {
          if (id === "second" && completeSecond) {
            clearInterval(timer);
            resolve(
              Response.json({
                id: "second",
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
            );
          }
        }, 5);
        input.signal.addEventListener(
          "abort",
          () => {
            clearInterval(timer);
            cancelled.add(id);
            reject(input.signal.reason);
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", upstream);
  const abort = new AbortController();
  const firstRequest = new Request(request(), { signal: abort.signal });
  firstRequest.headers.set("x-custom", "first");
  const secondRequest = request();
  secondRequest.headers.set("x-custom", "second");
  const first = dispatch(firstRequest);
  const second = dispatch(secondRequest);
  await expect.poll(() => started.size).toBe(2);
  abort.abort();
  const cancelledResponse = await first;
  expect(cancelledResponse.status).toBe(499);
  await cancelledResponse.body?.cancel();
  expect([...cancelled]).toEqual(["first"]);
  completeSecond = true;
  expect(await (await second).json()).toMatchObject({ id: "second" });
  expect(upstream).toHaveBeenCalledTimes(2);
});

test("SSE retries and final usage execute once inside the request object", async () => {
  const config = parseConfig(
    JSON.parse((await env.CODY_CONFIG_KV.get(env.CONFIG_KEY))!),
  );
  config.providers[0]!.retry = {
    status_codes: [429],
    error_codes: ["rate_limit_exceeded"],
    delays_ms: [0],
  };
  await env.CODY_CONFIG_KV.put(env.CONFIG_KEY, JSON.stringify(config));
  const metering = vi.spyOn(RequestMeter.prototype, "response");
  const requests: string[] = [];
  const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const finalBody = event({
    type: "response.completed",
    response: {
      id: "done",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      expect(input.headers.get("authorization")).toBe("Bearer upstream-secret");
      requests.push(await input.text());
      const body =
        requests.length === 1
          ? event({
              type: "response.created",
              response: { status: "in_progress" },
            }) +
            event({
              type: "response.output_item.added",
              item: { type: "reasoning", summary: [] },
            }) +
            event({
              type: "response.failed",
              response: {
                status: "failed",
                error: { code: "rate_limit_exceeded" },
              },
            })
          : finalBody;
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
  expect(await (await dispatch(request())).text()).toBe(finalBody);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  expect(metering).toHaveBeenCalledTimes(1);
  const meter = metering.mock.contexts[0];
  if (!(meter instanceof RequestMeter))
    throw new Error("Missing request meter");
  expect(await meter.drain()).toBe(true);
  expect(meter.checkpoint()).toMatchObject({
    outcome: "success",
    response_id: "done",
    attempts: [{ status: 200, retry_delay_ms: 0 }, { status: 200 }],
    usage: { tokens: { input_tokens: 3, output_tokens: 2 } },
  });
});
