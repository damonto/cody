import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { parseConfig } from "../src/config/store.ts";
import { configureLogging } from "../src/shared/log.ts";
import { ProviderHealthState } from "../src/gateway/health/health.ts";
import { handleInference } from "../src/gateway/http/proxy.ts";
import { handleModels } from "../src/gateway/catalog/models.ts";
import { decodeRequestBody } from "../src/gateway/http/content-encoding.ts";
import { BodyTooLargeError } from "../src/gateway/http/body.ts";
import { upstreamErrorEvent } from "../src/gateway/websocket/websocket-protocol.ts";
import { RequestMeter } from "../src/telemetry/meter.ts";
import { socksFetch } from "../src/gateway/transport/socks-fetch.ts";
import { memoryProxy } from "./helpers/memory-socks.mjs";

configureLogging("off");
const MODEL = "gpt-5.5-codex";
const encoder = new TextEncoder();

function fixture({
  accounts = 2,
  backup = false,
  failWrite = false,
  failRead,
  retry,
} = {}) {
  const config = parseConfig({
    providers: [
      {
        type: "codex",
        id: "codex",
        disabled: false,
        priority: 100,
        models: [MODEL],
        account_selection: "session_affinity",
        credentials: Array.from({ length: accounts }, (_, index) => ({
          id: `account-${index + 1}`,
          priority: 100,
          disabled: false,
          auth: {
            type: "oauth",
            account_ref: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          },
        })),
        ...(retry ? { retry } : {}),
      },
      ...(backup
        ? [
            {
              type: "ai_gateway",
              id: "backup",
              base_url: "https://backup.example/v1",
              disabled: false,
              priority: 50,
              models: [MODEL],
              credentials: [
                {
                  id: "backup-key",
                  priority: 100,
                  disabled: false,
                  auth: { type: "api_key", api_key: "mock-backup-key" },
                },
              ],
            },
          ]
        : []),
    ],
    api_keys: [
      {
        id: "client",
        api_key: "mock-client-key",
        providers: backup ? ["codex", "backup"] : ["codex"],
      },
    ],
  });
  const states = new Map();
  const env = {
    LOG_LEVEL: "off",
    MODELS_CACHE_TTL_SECONDS: "0",
    HEALTH: {
      getByName(name) {
        if (!states.has(name)) states.set(name, new ProviderHealthState());
        const state = states.get(name);
        return {
          getStatus: async () => {
            if (
              (failRead === "provider" && name === "codex") ||
              (failRead === "credential" && name.startsWith("key:"))
            )
              throw new Error("mock health read failure");
            return state.getStatus();
          },
          recordSuccess: async () => state.recordSuccess(),
          recordFailure: async () => state.recordFailure(),
          recordImmediateFailure: async () => state.recordImmediateFailure(),
          clear: async () => state.clear(),
          recordCooldownUntil: async (...args) => {
            if (failWrite) throw new Error("mock quota write failure");
            return state.recordCooldownUntil(...args);
          },
        };
      },
    },
    PROVIDER_OAUTH_ACCOUNT: {
      getByName: () => ({
        run: async (command) => ({
          ok: true,
          data: {
            token: "mock-access",
            account_id: command.connection.credential_id,
          },
        }),
      }),
    },
  };
  return { config, client: config.api_keys[0], env, states };
}
const quota = () =>
  Response.json(
    { error: { type: "usage_limit_reached", resets_in_seconds: 600 } },
    { status: 429 },
  );
const request = (
  body = JSON.stringify({ model: MODEL, input: [] }),
  headers = {},
) =>
  new Request("https://gateway.example/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
const infer = (f, send, req = request(), retryOptions = {}, meter) =>
  handleInference(
    req,
    f.env,
    f.config,
    f.client,
    "responses",
    "codex-test",
    undefined,
    { send, ...retryOptions },
    undefined,
    meter,
  );
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const failed = (code = "insufficient_quota", output) => ({
  type: "response.failed",
  response: {
    id: "resp-quota",
    status: "failed",
    error: { code, resets_in_seconds: 600 },
    ...(output ? { output } : {}),
  },
});
const sse = (body) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });

function fragmentedResponse(body, headers = {}, status = 200) {
  const bytes = encoder.encode(body);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    }),
    { headers, status },
  );
}

function metering(f) {
  const events = [];
  const meter = new RequestMeter({
    requestId: "codex-usage",
    endpoint: "responses",
    method: "POST",
    protocol: "openai",
    sink: { send: async (event) => events.push(event) },
  });
  meter.configure(f.config);
  meter.authenticate(f.client.id);
  return { meter, events };
}

const completedResponse = {
  id: "resp-completed",
  object: "response",
  model: MODEL,
  status: "completed",
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
  },
};

test("Codex meters fragmented SSE without a media type through direct and SOCKS responses", async () => {
  const body =
    "\ufeff: keepalive\r\n\r\n" +
    event({ type: "response.created", response: { id: "resp-completed" } }) +
    event({ type: "response.output_text.delta", delta: "你好" }) +
    event({ type: "response.completed", response: completedResponse });
  for (const transport of ["direct", "socks"]) {
    const f = fixture();
    const { meter, events } = metering(f);
    const response = meter.response(
      await infer(
        f,
        async () => {
          if (transport === "direct")
            return fragmentedResponse(body, { "x-upstream": "preserved" });
          const bytes = Buffer.from(body);
          return socksFetch(
            new Request("http://upstream.test/responses"),
            { url: "socks5://proxy.test:1080" },
            memoryProxy(
              Buffer.concat([
                Buffer.from(
                  `HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\nx-upstream: preserved\r\n\r\n`,
                ),
                bytes,
              ]),
            ),
          );
        },
        request(),
        {},
        meter,
      ),
    );
    assert.equal(response.headers.get("content-type"), null);
    assert.equal(response.headers.get("x-upstream"), "preserved");
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      encoder.encode(body),
    );
    await meter.drain();
    const result = events.at(-1);
    assert.equal(result.transport, "sse");
    assert.equal(result.outcome, "success");
    assert.equal(result.response_id, "resp-completed");
    assert.equal(result.usage.status, "reported");
    assert.equal(result.usage.tokens.input_tokens, 100);
    assert.equal(result.usage.tokens.cache_read_tokens, 40);
    assert.equal(result.usage.tokens.output_tokens, 20);
    assert.equal(result.usage.tokens.reasoning_tokens, 5);
    assert.equal(result.upstream_observation.response.model, MODEL);
    for (const timing of ["first_response_ms", "ttft_ms", "first_text_ms"])
      assert.equal(typeof result[timing], "number");
    assert.equal(result.observation_issue, null);
  }
});

test("Codex preserves JSON usage and errors when the response media type is unknown", async () => {
  for (const [payload, status] of [
    [completedResponse, 200],
    [{ error: { code: "invalid_request", message: "mock" } }, 400],
  ]) {
    const f = fixture();
    const { meter, events } = metering(f);
    const body = `\n ${JSON.stringify(payload)}`;
    const response = meter.response(
      await infer(
        f,
        async () =>
          fragmentedResponse(body, { "content-type": "text/plain" }, status),
        request(JSON.stringify({ model: MODEL, input: [], stream: false })),
        {},
        meter,
      ),
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(await response.text(), body);
    await meter.drain();
    const result = events.at(-1);
    assert.equal(result.transport, "http");
    assert.equal(result.first_response_ms, null);
    assert.equal(result.ttft_ms, null);
    assert.equal(result.observation_issue, null);
    if (status === 200) {
      assert.equal(result.usage.tokens.input_tokens, 100);
      assert.equal(result.response_id, "resp-completed");
    } else {
      assert.equal(result.outcome, "failed");
      assert.equal(result.diagnostic_code, "invalid_request");
    }
  }
});

test("Codex detects unlabelled quota streams and switches only before output", async () => {
  for (const emittedOutput of [false, true]) {
    const f = fixture();
    const { meter, events } = metering(f);
    const calls = [];
    const first = emittedOutput
      ? { type: "response.output_text.delta", delta: "already sent" }
      : {
          type: "response.created",
          response: { id: "resp-quota", output: [] },
        };
    const rejected = event(first) + event(failed());
    const completed = event({
      type: "response.completed",
      response: completedResponse,
    });
    const response = meter.response(
      await infer(
        f,
        async (req) => {
          calls.push(req.headers.get("chatgpt-account-id"));
          return fragmentedResponse(calls.length === 1 ? rejected : completed);
        },
        request(),
        {},
        meter,
      ),
    );
    assert.equal(await response.text(), emittedOutput ? rejected : completed);
    await meter.drain();
    assert.deepEqual(
      calls,
      emittedOutput ? ["account-1"] : ["account-1", "account-2"],
    );
    assert.equal(
      f.states.get("key:codex:account-1").getStatus().reason,
      "quota",
    );
    assert.equal(events.at(-1).outcome, emittedOutput ? "failed" : "success");
    assert.equal(events.at(-1).transport, "sse");
  }
});

test("configured Codex retries retain usage from unlabelled discarded responses", async () => {
  const f = fixture({
    retry: {
      delays_ms: [0],
      status_codes: [],
      error_codes: ["rate_limit_exceeded"],
    },
  });
  const { meter, events } = metering(f);
  const calls = [];
  const response = meter.response(
    await infer(
      f,
      async (req) => {
        calls.push(req.headers.get("chatgpt-account-id"));
        return fragmentedResponse(
          event(
            calls.length === 1
              ? {
                  ...failed("rate_limit_exceeded"),
                  usage: { input_tokens: 10, output_tokens: 2 },
                }
              : { type: "response.completed", response: completedResponse },
          ),
        );
      },
      request(),
      {},
      meter,
    ),
  );
  await response.text();
  await meter.drain();
  assert.deepEqual(calls, ["account-1", "account-1"]);
  const result = events.at(-1);
  assert.equal(result.usage.tokens.input_tokens, 110);
  assert.equal(result.usage.tokens.output_tokens, 22);
  assert.equal(result.attempts[0].usage.tokens.input_tokens, 10);
  assert.equal(result.attempts[0].retry_diagnostic.reason, "error_code_match");
});

test("Codex quota switching never sends a started request to another provider", async () => {
  const f = fixture({ backup: true });
  const calls = [];
  const response = await infer(f, async (req) => {
    calls.push(new URL(req.url).hostname);
    return quota();
  });
  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["chatgpt.com", "chatgpt.com"]);
  assert.equal((await response.json()).error.type, "usage_limit_reached");
});

test("a failed quota write returns the upstream rejection without switching", async () => {
  for (const rejection of [quota, () => sse(event(failed()))]) {
    const f = fixture({ failWrite: true });
    const calls = [];
    const original = rejection();
    const expected = await original.text();
    const response = await infer(f, async (req) => {
      calls.push(req.headers.get("chatgpt-account-id"));
      return rejection();
    });
    assert.equal(await response.text(), expected);
    assert.deepEqual(calls, ["account-1"]);
    assert.equal(
      f.states.get("key:codex:account-1").getStatus().cooling_until,
      null,
    );
  }
});

test("Codex health read failures prevent upstream requests", async () => {
  for (const failRead of ["provider", "credential"]) {
    const f = fixture({ failRead });
    let calls = 0;
    const response = await infer(f, async () => {
      calls++;
      return Response.json({});
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
  }
});

test("a health read failure after exhaustion cannot trigger an automatic reset", async () => {
  const f = fixture();
  f.config.providers[0].auto_consume_resets = true;
  const getByName = f.env.HEALTH.getByName;
  let readsFail = false;
  let resetAttempts = 0;
  f.env.HEALTH.getByName = (name) => {
    if (name === "rotation:codex") resetAttempts++;
    const stub = getByName(name);
    return {
      ...stub,
      getStatus: async () => {
        if (readsFail) throw new Error("mock health read failure");
        return stub.getStatus();
      },
    };
  };
  let calls = 0;
  const response = await infer(f, async () => {
    calls++;
    readsFail = true;
    return quota();
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "quota_state_unavailable");
  assert.equal(calls, 1);
  assert.equal(resetAttempts, 0);
});

test("a rejected catalog account cools so the next request can use another account", async (t) => {
  const f = fixture();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (req) => {
    const account = req.headers.get("chatgpt-account-id");
    calls.push(account);
    return account === "account-1"
      ? Response.json(
          { error: { message: "mock rejected token" } },
          { status: 401 },
        )
      : Response.json({ models: [{ slug: MODEL, display_name: MODEL }] });
  });
  const statuses = [];
  for (let index = 0; index < 2; index++)
    statuses.push(
      (
        await handleModels(
          new Request("https://gateway.example/v1/models"),
          f.env,
          f.config,
          f.client,
          "catalog-test",
        )
      ).status,
    );
  assert.deepEqual(statuses, [502, 200]);
  assert.deepEqual(calls, ["account-1", "account-2"]);
  assert.ok(
    f.states.get("key:codex:account-1:catalog").getStatus().cooling_until >
      Date.now(),
  );
  assert.equal(f.states.has("key:codex:account-1"), false);
});

test("stream quota failures after an empty lifecycle preamble switch accounts without retrying the exhausted one", async () => {
  for (const code of ["insufficient_quota", "usage_not_included"]) {
    const f = fixture({
      retry: { delays_ms: [0], status_codes: [], error_codes: [code] },
    });
    const calls = [];
    const completed = event({
      type: "response.completed",
      response: { id: "healthy" },
    });
    const response = await infer(f, async (req) => {
      calls.push(req.headers.get("chatgpt-account-id"));
      return sse(
        calls.length === 1
          ? event({
              type: "response.created",
              response: { id: "resp-quota", output: [] },
            }) + event(failed(code))
          : completed,
      );
    });
    assert.deepEqual(calls, ["account-1", "account-2"]);
    assert.equal(await response.text(), completed);
    assert.equal(
      f.states.get("key:codex:account-1").getStatus().reason,
      "quota",
    );
  }
});

test("stream quota failures after output cool the account without replaying any bytes", async () => {
  const f = fixture({
    retry: {
      delays_ms: [0],
      status_codes: [],
      error_codes: ["insufficient_quota"],
    },
  });
  const output = event({
    type: "response.output_text.delta",
    delta: "already generated",
  });
  const failure = event(failed());
  const chunks = [output, failure];
  const calls = [];
  const response = await infer(f, async (req) => {
    calls.push(req.headers.get("chatgpt-account-id"));
    return sse(
      new ReadableStream(
        {
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(encoder.encode(chunk));
            else controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    );
  });
  assert.equal(
    f.states.get("key:codex:account-1").getStatus().cooling_until,
    null,
  );
  assert.equal(await response.text(), output + failure);
  assert.deepEqual(calls, ["account-1"]);
  assert.equal(f.states.get("key:codex:account-1").getStatus().reason, "quota");
});

test(
  "late quota writes complete in the background without stalling SSE forwarding",
  { timeout: 2000 },
  async (t) => {
    const output = event({
      type: "response.output_text.delta",
      delta: "generated",
    });
    const failure = event(failed());
    for (const chunks of [[output + failure], [output, failure]]) {
      const f = fixture();
      const gate = Promise.withResolvers();
      t.after(gate.resolve);
      const background = [];
      let writes = 0;
      let calls = 0;
      const getByName = f.env.HEALTH.getByName;
      f.env.HEALTH.getByName = (name) => {
        const stub = getByName(name);
        return {
          ...stub,
          recordCooldownUntil: async (...args) => {
            writes++;
            await gate.promise;
            return stub.recordCooldownUntil(...args);
          },
        };
      };
      const response = await handleInference(
        request(),
        f.env,
        f.config,
        f.client,
        "responses",
        "background-quota",
        {
          waitUntil: (promise) => {
            background.push(promise);
          },
        },
        {
          send: async () => {
            calls++;
            return sse(
              new ReadableStream(
                {
                  pull(controller) {
                    const chunk = chunks.shift();
                    if (chunk) controller.enqueue(encoder.encode(chunk));
                    else controller.close();
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          },
        },
      );
      assert.equal(await response.text(), output + failure);
      assert.equal(calls, 1);
      assert.equal(writes, 1);
      assert.equal(
        f.states.get("key:codex:account-1").getStatus().cooling_until,
        null,
      );
      gate.resolve();
      await Promise.all(background);
      assert.equal(
        f.states.get("key:codex:account-1").getStatus().reason,
        "quota",
      );
    }
  },
);

test(
  "a quota failure received after the preflight deadline is observed without starting another preflight",
  { timeout: 2000 },
  async () => {
    const f = fixture({
      retry: {
        delays_ms: [0],
        status_codes: [],
        error_codes: ["insufficient_quota"],
      },
    });
    let controller;
    let calls = 0;
    const response = await infer(
      f,
      async () => {
        calls++;
        return sse(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
        );
      },
      request(),
      { attemptTimeoutMs: 10 },
    );
    const failure = event(failed());
    controller.enqueue(encoder.encode(failure));
    controller.close();
    assert.equal(await response.text(), failure);
    assert.equal(calls, 1);
    assert.equal(
      f.states.get("key:codex:account-1").getStatus().reason,
      "quota",
    );
  },
);

test("a response.failed carrying output does not authorize account switching", async () => {
  const f = fixture();
  const body = event(
    failed("insufficient_quota", [
      { type: "message", content: [{ type: "output_text", text: "partial" }] },
    ]),
  );
  let calls = 0;
  const response = await infer(f, async () => {
    calls++;
    return sse(body);
  });
  assert.equal(await response.text(), body);
  assert.equal(calls, 1);
  assert.equal(f.states.get("key:codex:account-1").getStatus().reason, "quota");
});

test("generic Codex 429s still apply only the configured retries on the same account", async () => {
  const f = fixture({
    retry: { delays_ms: [0], status_codes: [429], error_codes: [] },
  });
  const calls = [];
  const response = await infer(f, async (req) => {
    calls.push(req.headers.get("chatgpt-account-id"));
    return Response.json(
      { error: { code: "rate_limit_exceeded" } },
      { status: 429 },
    );
  });
  await response.text();
  assert.deepEqual(calls, ["account-1", "account-1"]);
  assert.equal(
    f.states.get("key:codex:account-1").getStatus().cooling_until,
    null,
  );
});

test("cancelling Codex quota preflight returns 499 and cancels the upstream body", async () => {
  const f = fixture();
  const controller = new AbortController();
  let cancelled = false;
  const response = await infer(
    f,
    async () => {
      queueMicrotask(() => controller.abort());
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 429 },
      );
    },
    new Request(request(), { signal: controller.signal }),
  );
  assert.equal(response.status, 499);
  assert.equal(cancelled, true);
  assert.equal(f.states.get("codex").getStatus().failures, 0);
});

test("zstd inference preserves compressed bytes and clears invalidated headers on model rewrites", async () => {
  for (const rewrite of [false, true]) {
    const f = fixture();
    f.config.model_routes = { alias: { model: MODEL } };
    const text = JSON.stringify({
      model: rewrite ? "alias" : MODEL,
      input: [{ role: "user", content: "hello" }],
    });
    const compressed = zstdCompressSync(encoder.encode(text));
    let upstream;
    const response = await infer(
      f,
      async (req) => {
        upstream = {
          headers: req.headers,
          body: new Uint8Array(await req.arrayBuffer()),
        };
        return Response.json({ id: "ok" });
      },
      request(compressed, {
        "content-encoding": "zstd",
        "content-md5": "original-digest",
        digest: "original-digest",
        "content-digest": "original-digest",
      }),
    );
    assert.equal(response.status, 200);
    if (rewrite) {
      assert.equal(
        JSON.parse(new TextDecoder().decode(upstream.body)).model,
        MODEL,
      );
      for (const name of [
        "content-encoding",
        "content-md5",
        "digest",
        "content-digest",
      ])
        assert.equal(upstream.headers.get(name), null);
    } else {
      assert.deepEqual(upstream.body, new Uint8Array(compressed));
      assert.equal(upstream.headers.get("content-encoding"), "zstd");
      assert.equal(upstream.headers.get("content-md5"), "original-digest");
    }
  }
});

test("compressed uploads reject invalid encodings and bound the decompressed size", async () => {
  const f = fixture();
  const never = async () => {
    assert.fail("invalid upload must not reach upstream");
  };
  for (const [encoding, status] of [
    ["zstd", 400],
    ["unknown", 415],
  ])
    assert.equal(
      (
        await infer(
          f,
          never,
          request("not compressed", { "content-encoding": encoding }),
        )
      ).status,
      status,
    );
  const signal = new AbortController().signal;
  const compressed = zstdCompressSync(encoder.encode("x".repeat(2048)));
  await assert.rejects(
    decodeRequestBody(compressed, "zstd", 32, signal),
    BodyTooLargeError,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    decodeRequestBody(compressed, "zstd", 4096, controller.signal),
    { name: "AbortError" },
  );
});

test("HTTP WebSocket errors retain their upstream details in a Codex error envelope", async () => {
  for (const status of [401, 429, 503]) {
    const error = {
      type: "usage_limit_reached",
      message: "mock error",
      resets_at: 1900000000,
    };
    const wrapped = JSON.parse(
      await upstreamErrorEvent(
        Response.json({ error }, { status, headers: { "retry-after": "60" } }),
      ),
    );
    assert.equal(wrapped.type, "error");
    assert.equal(wrapped.status, status);
    assert.equal(wrapped.headers["retry-after"], "60");
    assert.deepEqual(wrapped.error, error);
  }
  const wrapped = JSON.parse(
    await upstreamErrorEvent(new Response("not json", { status: 502 })),
  );
  assert.equal(wrapped.type, "error");
  assert.equal(wrapped.status, 502);
  assert.equal(wrapped.error.message, "not json");
});

test("WebSocket rejection bodies time out, cancel upstream reads and retain status and headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 503, headers: { "retry-after": "60" } },
  );
  const pending = upstreamErrorEvent(response);
  t.mock.timers.tick(10_000);
  const wrapped = JSON.parse(await pending);
  assert.equal(wrapped.type, "error");
  assert.equal(wrapped.status, 503);
  assert.equal(wrapped.headers["retry-after"], "60");
  assert.equal(wrapped.error.code, "websocket_upgrade_failed");
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
