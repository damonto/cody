import assert from "node:assert/strict";
import test from "node:test";
import { inspectCodexResponse } from "../src/providers/codex/inspect.ts";
import { codexUsageLimitFromError } from "../src/providers/codex/limits.ts";
import { errorStatus } from "../src/gateway/websocket/websocket-protocol.ts";
import {
  upstreamErrorCode,
  upstreamErrorHeader,
  upstreamEventType,
} from "../src/shared/upstream-error.ts";
import { fetchWithConfiguredRetries } from "../src/gateway/http/upstream-retry.ts";

const now = 1_800_000_000_000;
const signal = new AbortController().signal;
const sse = (payload, event = "") =>
  new Response(
    `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

test("body-wrapped and typeless Codex quota errors use the shared preflight without rewriting bytes", async () => {
  const error = { type: "usage_limit_reached", resets_at: now / 1000 + 120 };
  for (const payload of [
    { body: { error, status: 429 } },
    { type: "error", body: { error }, status_code: 429 },
    { response: { error }, status: 429 },
  ]) {
    assert.equal(upstreamErrorCode(payload), error.type);
    assert.equal(upstreamEventType(payload), "error");
    assert.equal(errorStatus(payload), 429);
    for (const response of [
      Response.json(payload, { status: 429 }),
      sse(payload),
    ]) {
      const original = await response.clone().text();
      const result = await inspectCodexResponse(response, { signal, now });
      assert.equal(result.usageLimit.resets_at, now + 120_000);
      assert.equal(await result.response.text(), original);
    }
  }
});

test("nested error headers retain outer precedence and determine SIWC cooldowns", () => {
  for (const payload of [
    {
      type: "error",
      error: {
        code: "subscription_sharing_usage_limit_exceeded",
        headers: { "Retry-After": "120" },
      },
    },
    {
      type: "response.failed",
      response: {
        error: {
          type: "subscription_sharing_usage_limit_exceeded",
          headers: { "retry-after": "120" },
        },
      },
    },
    {
      body: {
        error: { code: "subscription_sharing_usage_limit_exceeded" },
        headers: { "retry-after": "120" },
      },
    },
  ]) {
    assert.equal(
      codexUsageLimitFromError(payload, () => null, now, "siwc").resets_at,
      now + 120_000,
    );
    payload.headers = { "Retry-After": "240" };
    assert.equal(upstreamErrorHeader(payload, "retry-after"), "240");
    assert.equal(
      codexUsageLimitFromError(payload, () => null, now, "siwc").resets_at,
      now + 240_000,
    );
  }
});

test("explicit metadata events and body-wrapped output cannot authorize quota replay", async () => {
  const error = { code: "usage_limit_reached" };
  for (const response of [
    sse({ type: "response.metadata", body: { error } }),
    sse({ body: { error } }, "response.metadata"),
    sse({ type: "response.completed", body: { error } }),
    sse({
      body: {
        error,
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "visible" }],
          },
        ],
      },
    }),
    sse({
      body: {
        error,
        item: { type: "function_call", name: "tool", arguments: "{}" },
      },
    }),
    sse({ body: { error, part: { type: "output_text", text: "visible" } } }),
  ]) {
    let cooled = false;
    const result = await inspectCodexResponse(response, {
      signal,
      now,
      onStreamLimit: async () => {
        cooled = true;
      },
    });
    assert.equal(result.usageLimit, undefined);
    const text = await result.response.text();
    assert.ok(text.includes("usage_limit_reached"));
    if (
      text.includes("response.metadata") ||
      text.includes("response.completed")
    )
      assert.equal(cooled, false);
  }
});

test("configured retries honor nested overload Retry-After without adding attempts", async () => {
  let calls = 0;
  const delays = [];
  const result = await fetchWithConfiguredRetries(
    () => new Request("https://upstream.test/responses"),
    {
      status_codes: [],
      error_codes: ["server_is_overloaded"],
      delays_ms: [10],
    },
    {
      send: async () => {
        calls++;
        return sse({
          type: "error",
          error: {
            code: "server_is_overloaded",
            headers: { "retry-after": "326" },
          },
        });
      },
      wait: async (delay) => delays.push(delay),
    },
  );
  await result.response.body.cancel();
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 325_000 && delays[0] <= 326_000);
});

test("status-code retries observe nested hints while transport headers keep precedence", async () => {
  for (const transportHint of [undefined, "2"]) {
    let calls = 0;
    const delays = [];
    const result = await fetchWithConfiguredRetries(
      () => new Request("https://upstream.test/responses"),
      { status_codes: [503], delays_ms: [10] },
      {
        send: async () => {
          calls++;
          return Response.json(
            {
              error: {
                code: "server_is_overloaded",
                headers: { "retry-after": "120" },
              },
            },
            {
              status: 503,
              headers: transportHint ? { "retry-after": transportHint } : {},
            },
          );
        },
        inspectResponse: async (response, signal, timeoutMs) => {
          const { response: inspected, ...retry } = await inspectCodexResponse(
            response,
            { signal, timeoutMs, inspectErrorHeaders: true },
          );
          return { response: inspected, terminal: false, retry };
        },
        wait: async (delay) => delays.push(delay),
      },
    );
    await result.response.body.cancel();
    assert.equal(calls, 2);
    const expected = Number(transportHint ?? "120") * 1000;
    assert.ok(delays[0] >= expected - 1000 && delays[0] <= expected);
  }
});
