import assert from "node:assert/strict";
import test from "node:test";
import {
  antigravityAccountLimit,
  DEFAULT_ANTIGRAVITY_COOLDOWN_MS,
} from "../src/providers/antigravity/limits.ts";
import {
  inspectAntigravityResponse,
  MAX_ANTIGRAVITY_PREFLIGHT_MS,
} from "../src/providers/antigravity/inspect.ts";
import { openPart, sealPart } from "../src/providers/antigravity/replay.ts";
import { antigravityModelAvailability } from "../src/providers/antigravity/availability.ts";
import {
  fetchWithConfiguredRetries,
  UpstreamAttemptTimeoutError,
} from "../src/gateway/http/proxy.ts";
import {
  newAntigravityProvider,
  applySettings,
  settingsFormValues,
} from "../console/src/features/antigravity/form-options.ts";

const now = 1_800_000_000_000;
const headers = new Headers();
function failure(reason = "QUOTA_EXHAUSTED", delay = "60s") {
  return {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason },
        ...(delay
          ? [
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: delay,
              },
            ]
          : []),
      ],
    },
  };
}
function stream(events, fragmented = false) {
  const bytes = new TextEncoder().encode(
    events
      .map((event) =>
        typeof event === "string"
          ? event
          : `data: ${JSON.stringify(event)}\r\n\r\n`,
      )
      .join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const next = Math.min(
          bytes.length,
          offset + (fragmented ? 3 : bytes.length),
        );
        controller.enqueue(bytes.slice(offset, next));
        offset = next;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const signal = () => new AbortController().signal;

test("quota coordination failures never make an account available", async () => {
  const env = {
    HEALTH: {
      getByName: () => ({
        getStatus: async () => {
          throw new Error("unavailable");
        },
      }),
    },
  };
  const status = await antigravityModelAvailability(env, "account", "model");
  assert.equal(status.available, false);
  assert.equal(status.reason, "health_read_failed");
});

test("configured retries cannot renew the shared account-switch deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  let sends = 0;
  const delays = [];
  const result = await fetchWithConfiguredRetries(
    () => new Request("https://upstream.test"),
    { status_codes: [503], delays_ms: [200] },
    {
      deadline: now + 50,
      attemptTimeoutMs: 1000,
      send: async () => {
        sends++;
        return new Response("busy", { status: 503 });
      },
      wait: async (ms) => {
        delays.push(ms);
        t.mock.timers.tick(ms);
      },
    },
  );
  assert.equal(sends, 1);
  assert.deepEqual(delays, [50]);
  assert.ok(result.error instanceof UpstreamAttemptTimeoutError);
});

test("Antigravity selection defaults to rotation and settings retain either strategy", () => {
  const provider = newAntigravityProvider();
  assert.equal(provider.account_selection, "round_robin");
  for (const account_selection of ["round_robin", "session_affinity"]) {
    assert.equal(
      applySettings(provider, {
        ...settingsFormValues(provider),
        account_selection,
      }).account_selection,
      account_selection,
    );
  }
  assert.throws(() =>
    applySettings(provider, {
      ...settingsFormValues(provider),
      account_selection: "random",
    }),
  );
});

test("discarded-response observation counts against the shared retry deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  let sends = 0;
  const delays = [];
  const result = await fetchWithConfiguredRetries(
    () => new Request("https://upstream.test"),
    { status_codes: [503], delays_ms: [200] },
    {
      deadline: now + 50,
      attemptTimeoutMs: 1000,
      send: async () => {
        sends++;
        return new Response("busy", { status: 503 });
      },
      observeDiscardedResponse: async () => {
        t.mock.timers.tick(40);
        return null;
      },
      wait: async (ms) => {
        delays.push(ms);
        t.mock.timers.tick(ms);
      },
    },
  );
  assert.equal(sends, 1);
  assert.deepEqual(delays, [10]);
  assert.ok(result.error instanceof UpstreamAttemptTimeoutError);
});

test("quota errors and timed rate limits use structured reset hints, not capacity errors", () => {
  assert.deepEqual(antigravityAccountLimit(failure(), headers, now), {
    code: "QUOTA_EXHAUSTED",
    resets_at: now + 60_000,
  });
  assert.equal(
    antigravityAccountLimit(failure("QUOTA_EXHAUSTED", undefined), headers, now)
      .resets_at,
    now + 60_000,
  );
  assert.equal(
    antigravityAccountLimit(failure("QUOTA_EXHAUSTED", ""), headers, now)
      .resets_at,
    now + DEFAULT_ANTIGRAVITY_COOLDOWN_MS,
  );
  assert.equal(
    antigravityAccountLimit(
      failure("RATE_LIMIT_EXCEEDED", "0.479s"),
      headers,
      now,
    ).resets_at,
    now + 479,
  );
  assert.equal(
    antigravityAccountLimit(failure("RATE_LIMIT_EXCEEDED", ""), headers, now),
    undefined,
  );
  assert.equal(
    antigravityAccountLimit(failure("MODEL_CAPACITY_EXHAUSTED"), headers, now),
    undefined,
  );
  assert.equal(
    antigravityAccountLimit(
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Resource exhausted, try again later",
        },
      },
      headers,
      now,
    ),
    undefined,
  );
  const value = failure();
  value.error.details[0].metadata = {
    quotaResetTimeStamp: new Date(now + 120_000).toISOString(),
    quotaResetDelay: "90s",
  };
  assert.equal(
    antigravityAccountLimit(value, new Headers({ "retry-after": "30" }), now)
      .resets_at,
    now + 120_000,
  );
  value.error.details[0].metadata.quotaResetTimeStamp = "invalid";
  assert.equal(
    antigravityAccountLimit(value, headers, now).resets_at,
    now + 90_000,
  );
  assert.equal(
    antigravityAccountLimit(
      failure("RATE_LIMIT_EXCEEDED", "invalid"),
      new Headers({ "retry-after": "30" }),
      now,
    ).resets_at,
    now + 30_000,
  );
  assert.equal(
    antigravityAccountLimit(
      failure("RATE_LIMIT_EXCEEDED", "-2s"),
      headers,
      now,
    ),
    undefined,
  );
});

test("HTTP limit inspection preserves response bytes and ignores malformed errors", async () => {
  for (const body of [
    JSON.stringify(failure()),
    "not json",
    "x".repeat(128 * 1024),
  ]) {
    const response = new Response(body, { status: 429 });
    const result = await inspectAntigravityResponse(
      response,
      async () => assert.fail(),
      signal(),
    );
    assert.equal(await result.response.text(), body);
    assert.equal(Boolean(result.accountLimit), body.startsWith("{"));
  }
});

test("preflight hands off a stalled stream within its bound without losing the pending read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let source;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        source = controller;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const inspected = inspectAntigravityResponse(
    response,
    async () => {},
    signal(),
  );
  t.mock.timers.tick(MAX_ANTIGRAVITY_PREFLIGHT_MS);
  const result = await inspected;
  assert.equal(result.accountLimit, undefined);
  source.enqueue(new TextEncoder().encode('data: {"hello":true}\n\n'));
  source.close();
  assert.equal(await result.response.text(), 'data: {"hello":true}\n\n');
});

test("a large transport chunk cannot extend the inspection byte limit", async () => {
  const source = stream([": heartbeat\n\n".repeat(6000), failure()]);
  const expected = await source.clone().text();
  const observed = [];
  const result = await inspectAntigravityResponse(
    source,
    async (limit) => {
      observed.push(limit);
    },
    signal(),
  );
  assert.equal(result.accountLimit, undefined);
  assert.equal(await result.response.text(), expected);
  assert.equal(observed.length, 1);
});

test("SSE preflight detects fragmented first-event limits and leaves successful streams byte-identical", async () => {
  for (const fragmented of [false, true]) {
    const response = stream([": heartbeat\r\n\r\n", failure()], fragmented);
    const errorBytes = await response.clone().text();
    const result = await inspectAntigravityResponse(
      response,
      async () => assert.fail(),
      signal(),
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.accountLimit.code, "QUOTA_EXHAUSTED");
    assert.equal(
      result.response.headers.get("content-type"),
      "text/event-stream",
    );
    assert.equal(await result.response.text(), errorBytes);
    const success = stream(
      [
        {
          response: {
            candidates: [{ content: { parts: [{ text: "你好" }] } }],
          },
        },
      ],
      fragmented,
    );
    const expected = await success.clone().text();
    const inspected = await inspectAntigravityResponse(
      success,
      async () => assert.fail(),
      signal(),
    );
    assert.equal(inspected.accountLimit, undefined);
    assert.equal(await inspected.response.text(), expected);
  }
});

test("a limit after output cools the account without making the stream replayable", async () => {
  const observed = [];
  const response = stream([
    {
      response: { candidates: [{ content: { parts: [{ text: "started" }] } }] },
    },
    failure(),
  ]);
  const expected = await response.clone().text();
  const result = await inspectAntigravityResponse(
    response,
    async (limit) => {
      observed.push(limit);
    },
    signal(),
  );
  assert.equal(result.accountLimit, undefined);
  assert.equal(await result.response.text(), expected);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].code, "QUOTA_EXHAUSTED");
});

test("SSE preflight cancellation releases its upstream reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const result = inspectAntigravityResponse(
    response,
    async () => {},
    controller.signal,
  );
  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("aborting after prefix inspection rejects the forwarded body and releases its reader", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const source = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"response":{}}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const result = await inspectAntigravityResponse(
    source,
    async () => {},
    abort.signal,
  );
  abort.abort(new Error("cancelled after inspection"));
  await assert.rejects(result.response.text(), /cancelled after inspection/);
  assert.equal(cancelled, true);
  assert.equal(source.body.locked, false);
});

test("malformed unrelated details do not hide a valid quota reason, and structured capacity reasons win", () => {
  const quota = failure();
  quota.error.details.push("unknown upstream detail");
  assert.equal(
    antigravityAccountLimit(quota, headers, now).code,
    "QUOTA_EXHAUSTED",
  );
  const capacity = failure("MODEL_CAPACITY_EXHAUSTED");
  capacity.error.message = "Model capacity unavailable, not quota exhausted";
  assert.equal(antigravityAccountLimit(capacity, headers, now), undefined);
});

test("trusted replay can move inside an account pool while client, model and provenance stay checked", async () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const source = {
    client_id: "client",
    provider_id: "antigravity",
    account_ref: "a",
    model: "gemini",
  };
  const envelope = await sealPart(
    { text: "thought", thought: true, thoughtSignature: "native" },
    "self",
    source,
    key,
  );
  const target = { ...source, account_ref: "b" };
  await assert.rejects(openPart(envelope, target, key), /does not belong/);
  assert.equal(
    (await openPart(envelope, target, key, ["a", "b"])).part.thoughtSignature,
    "native",
  );
  await assert.rejects(
    openPart(envelope, target, key, ["b"]),
    /does not belong/,
  );
  for (const field of ["client_id", "provider_id", "model"])
    await assert.rejects(
      openPart(envelope, { ...target, [field]: "foreign" }, key, ["a", "b"]),
      /does not belong/,
    );
});
