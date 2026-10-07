import assert from "node:assert/strict";
import test from "node:test";
import { compareUpstream } from "../src/shared/upstream-observation.ts";
import {
  inferenceMetadata,
  responseMetadata,
} from "../src/telemetry/inference-metadata.ts";
import { RequestMeter } from "../src/telemetry/meter.ts";
import { parseUsageEvent } from "../src/telemetry/schema.ts";
import { WebSocketUsage } from "../src/gateway/websocket/usage.ts";
import { convertResponse as antigravityResponse } from "../src/providers/antigravity/response.ts";
import { convertResponse as xaiResponse } from "../src/providers/xai/response.ts";
import { antigravityMetadata } from "../src/providers/antigravity/observation.ts";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const target = {
  providerId: "provider",
  credentialId: "account",
  model: "real-model",
};
const scope = {
  provider_id: "provider",
  account_ref: "account",
  client_id: "client",
  model: "real-model",
};
const wireUsage = {
  input_tokens: 10,
  output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 2 },
};
const sse = (events) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

function fixture(
  protocol = "openai",
  request = { model: "real-model", reasoning: { effort: "high" } },
) {
  const meter = new RequestMeter({
    requestId: crypto.randomUUID(),
    endpoint: protocol === "anthropic" ? "messages" : "responses",
    protocol,
    method: "POST",
    sink: { send: async () => {} },
  });
  meter.requestedModel("alias");
  meter.upstreamRequest(request);
  meter.select(target);
  return meter;
}

test("comparison ignores returned model namespaces and compares only requested reasoning fields", () => {
  for (const [request, response, expected] of [
    [
      { model: "gpt-test" },
      { model: "gpt-test" },
      { model: "match", reasoning: "unknown", differences: [] },
    ],
    [
      { model: "gpt-test" },
      { model: "openai/gpt-test" },
      { model: "match", reasoning: "unknown", differences: [] },
    ],
    [
      { model: "gpt-test" },
      { model: "gateway/openai/gpt-test" },
      { model: "match", reasoning: "unknown", differences: [] },
    ],
    [
      { model: "gpt-test" },
      { model: "openai/gpt-test-2026-10-01" },
      {
        model: "mismatch",
        reasoning: "unknown",
        differences: [
          {
            field: "model",
            requested: "gpt-test",
            returned: "openai/gpt-test-2026-10-01",
          },
        ],
      },
    ],
    [
      { model: "gpt-test" },
      { model: "openai/" },
      { model: "unknown", reasoning: "unknown", differences: [] },
    ],
    [
      { model: "gpt-test" },
      { model: "gpt-test-2026-10-01" },
      {
        model: "mismatch",
        reasoning: "unknown",
        differences: [
          {
            field: "model",
            requested: "gpt-test",
            returned: "gpt-test-2026-10-01",
          },
        ],
      },
    ],
    [
      { reasoning: { effort: "high" } },
      { reasoning: { effort: "low" } },
      {
        model: "unknown",
        reasoning: "mismatch",
        differences: [{ field: "effort", requested: "high", returned: "low" }],
      },
    ],
    [
      { reasoning: { effort: "high" } },
      { reasoning: { effort: "high" } },
      { model: "unknown", reasoning: "match", differences: [] },
    ],
    [
      { reasoning: { budget_tokens: 8192 } },
      { reasoning: { effort: "high" } },
      { model: "unknown", reasoning: "unknown", differences: [] },
    ],
    [
      { reasoning: { effort: "high", mode: "adaptive" } },
      { reasoning: { effort: "high" } },
      { model: "unknown", reasoning: "unknown", differences: [] },
    ],
    [
      { reasoning: { effort: "high", mode: "adaptive" } },
      { reasoning: { mode: "disabled" } },
      {
        model: "unknown",
        reasoning: "mismatch",
        differences: [
          { field: "mode", requested: "adaptive", returned: "disabled" },
        ],
      },
    ],
    [
      {},
      { reasoning: { effort: "high" } },
      { model: "unknown", reasoning: "unknown", differences: [] },
    ],
    [
      { reasoning: { budget_tokens: 0 } },
      { reasoning: { budget_tokens: 0 } },
      { model: "unknown", reasoning: "match", differences: [] },
    ],
  ])
    assert.deepEqual(compareUpstream({ request, response }), expected);
  assert.deepEqual(compareUpstream(undefined), {
    model: "unknown",
    reasoning: "unknown",
    differences: [],
  });
});

test("comparison includes every differing field without turning missing fields into differences", () => {
  assert.deepEqual(
    compareUpstream({
      request: {
        model: "m",
        reasoning: { effort: "high", mode: "adaptive", budget_tokens: 8192 },
      },
      response: {
        model: "m-v2",
        reasoning: { effort: "low", budget_tokens: 4096 },
      },
    }),
    {
      model: "mismatch",
      reasoning: "mismatch",
      differences: [
        { field: "model", requested: "m", returned: "m-v2" },
        { field: "effort", requested: "high", returned: "low" },
        { field: "budget_tokens", requested: 8192, returned: 4096 },
      ],
    },
  );
});

test("metadata extracts dialect fields without defaults, budget conversion or sensitive content", () => {
  assert.deepEqual(
    inferenceMetadata(
      { model: "m", reasoning_effort: "xhigh", input: "private" },
      "openai",
    ),
    { model: "m", reasoning: { effort: "xhigh" } },
  );
  assert.deepEqual(
    inferenceMetadata(
      {
        thinking: { type: "enabled", budget_tokens: 8192 },
        output_config: { effort: "max" },
      },
      "anthropic",
    ),
    { reasoning: { effort: "max", mode: "enabled", budget_tokens: 8192 } },
  );
  assert.deepEqual(
    antigravityMetadata("gemini-test-high", {
      thinkingLevel: "high",
      thinkingBudget: -1,
    }),
    {
      model: "gemini-test-high",
      reasoning: { effort: "high", budget_tokens: -1 },
    },
  );
  for (const payload of [
    null,
    [],
    { model: " " },
    { model: "x".repeat(257) },
    { model: 1, reasoning: { effort: {} } },
    { usage: wireUsage },
    { thinking: { budget_tokens: -2 } },
  ])
    assert.deepEqual(inferenceMetadata(payload, "openai"), {});
  assert.deepEqual(
    responseMetadata(
      {
        type: "message_start",
        message: {
          model: "claude-test",
          content: [{ type: "thinking", thinking: "private" }],
        },
      },
      "anthropic",
    ),
    { model: "claude-test" },
  );
});

for (const protocol of ["openai", "anthropic"]) {
  for (const streaming of [false, true]) {
    test(`${protocol} ${streaming ? "SSE" : "JSON"} preserves bytes and records original upstream metadata`, async () => {
      const meter = fixture(protocol);
      const payload = {
        model: "real-model-v2",
        ...(protocol === "openai" ? { reasoning: { effort: "low" } } : {}),
        usage:
          protocol === "openai"
            ? wireUsage
            : {
                input_tokens: 10,
                output_tokens: 3,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
      };
      const frames =
        protocol === "openai"
          ? [
              {
                type: "response.created",
                response: {
                  model: "real-model",
                  reasoning: { effort: "high" },
                },
              },
              { type: "response.completed", response: payload },
            ]
          : [
              { type: "message_start", message: payload },
              { type: "message_stop" },
            ];
      const source = streaming ? sse(frames) : Response.json(payload);
      const expected = await source.clone().text();
      assert.equal(
        await meter.response(meter.passthroughResponse(source)).text(),
        expected,
      );
      const result = meter.checkpoint();
      assert.equal(result.outcome, "success");
      assert.equal(result.usage.tokens.input_tokens, 10);
      assert.equal(result.upstream_observation.response.model, "real-model-v2");
      assert.deepEqual(compareUpstream(result.upstream_observation), {
        model: "mismatch",
        reasoning: protocol === "openai" ? "mismatch" : "unknown",
        differences: [
          {
            field: "model",
            requested: "real-model",
            returned: "real-model-v2",
          },
          ...(protocol === "openai"
            ? [{ field: "effort", requested: "high", returned: "low" }]
            : []),
        ],
      });
      assert.equal(result.requested_model, "alias");
      assert.deepEqual(
        parseUsageEvent(result).upstream_observation,
        result.upstream_observation,
      );
      await meter.drain();
    });
  }
}

test("only the registered upstream response may contribute passthrough metadata", async () => {
  const meter = fixture();
  const upstream = Response.json({ model: "real-model" });
  assert.equal(meter.passthroughResponse(upstream), upstream);
  // A replacement body may contain synthetic model and reasoning fields.
  const replacement = Response.json({
    model: "alias",
    reasoning: { effort: "high" },
    usage: wireUsage,
  });
  await meter.response(replacement).text();
  assert.deepEqual(meter.checkpoint().upstream_observation.response, {});
  assert.equal(meter.checkpoint().usage.tokens.input_tokens, 10);
  await meter.drain();
});

test("terminal metadata wins field by field and cancellation retains observed values", () => {
  const meter = fixture();
  meter.observeUpstream({
    model: "real-model",
    reasoning: { effort: "high", mode: "adaptive" },
  });
  meter.observeUpstream(
    { model: "final-model", reasoning: { effort: "low" } },
    true,
  );
  meter.observeUpstream({
    model: "late-model",
    reasoning: { effort: "high", mode: "adaptive" },
  });
  const result = meter.finish("cancelled", 200);
  meter.observeUpstream({ model: "after-finish" }, true);
  assert.deepEqual(result.upstream_observation.response, {
    model: "final-model",
    reasoning: { effort: "low", mode: "adaptive" },
  });
  assert.deepEqual(
    meter.checkpoint().upstream_observation,
    result.upstream_observation,
  );
});

test("legacy events remain absent and new metadata is validated at the event boundary", () => {
  const result = fixture().finish("success", 200);
  delete result.upstream_observation;
  assert.equal(
    Object.hasOwn(parseUsageEvent(result), "upstream_observation"),
    false,
  );
  for (const invalid of [
    null,
    { request: {}, response: { model: 42 } },
    { request: { reasoning: { budget_tokens: "8192" } }, response: {} },
  ])
    assert.throws(() =>
      parseUsageEvent({ ...result, upstream_observation: invalid }),
    );
});

for (const streaming of [false, true]) {
  test(`Antigravity ${streaming ? "SSE" : "JSON"} observes native model before synthetic model and reasoning`, async () => {
    const meter = fixture();
    const raw = {
      response: {
        modelVersion: "native-version",
        candidates: [
          { content: { parts: [{ text: "hello" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      },
    };
    const converted = await antigravityResponse(
      streaming ? sse([raw]) : Response.json(raw),
      {
        protocol: "openai",
        model: "alias",
        scope,
        key,
        tools: [],
        stream: streaming,
        request: { reasoning: { effort: "high" } },
        observe: (metadata, terminal) =>
          meter.observeUpstream(metadata, terminal),
      },
    );
    const text = await meter.response(converted).text();
    assert.ok(text.includes('"model":"alias"'));
    assert.ok(text.includes('"effort":"high"'));
    assert.deepEqual(meter.checkpoint().upstream_observation.response, {
      model: "native-version",
    });
    assert.equal(
      compareUpstream(meter.checkpoint().upstream_observation).reasoning,
      "unknown",
    );
    await meter.drain();
  });

  test(`xAI ${streaming ? "SSE" : "JSON"} observes original model and effort before conversion`, async () => {
    const meter = fixture("anthropic");
    const converted = await xaiResponse(
      sse([
        {
          type: "response.created",
          response: {
            id: "resp-test",
            model: "native-model",
            reasoning: { effort: "high" },
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp-test",
            model: "native-version",
            reasoning: { effort: "low" },
            status: "completed",
            output: [],
            usage: wireUsage,
          },
        },
      ]),
      {
        anthropic: true,
        stream: streaming,
        model: "alias",
        scope,
        key,
        tools: [],
        observe: (metadata, terminal) =>
          meter.observeUpstream(metadata, terminal),
      },
    );
    assert.ok(
      (await meter.response(converted).text()).includes('"model":"alias"'),
    );
    assert.deepEqual(meter.checkpoint().upstream_observation.response, {
      model: "native-version",
      reasoning: { effort: "low" },
    });
    await meter.drain();
  });
}

test("adapter metadata observer failures do not interrupt response conversion", async () => {
  const converted = await antigravityResponse(
    Response.json({
      candidates: [
        { content: { parts: [{ text: "hello" }] }, finishReason: "STOP" },
      ],
    }),
    {
      protocol: "openai",
      model: "alias",
      scope,
      key,
      tools: [],
      stream: false,
      observe: () => {
        throw new Error("observer failed");
      },
    },
  );
  assert.equal((await converted.json()).status, "completed");
});

test("WebSocket turns keep distinct reasoning and response identities", async () => {
  const usage = new WebSocketUsage(
    { checkpoint: async () => {} },
    { send: async () => {} },
    { waitUntil: () => {} },
  );
  const context = { config: { providers: [] }, client: { id: "client" } };
  const selected = {
    provider: { id: "provider" },
    credential: { id: "account" },
    upstreamModel: "real-model",
  };
  const first = await usage.start(
    "connection",
    {
      model: "alias",
      payload: { model: "alias", reasoning: { effort: "high" } },
    },
    1000,
  );
  const second = await usage.start(
    "connection",
    {
      model: "alias",
      payload: { model: "alias", reasoning: { effort: "low" } },
    },
    2000,
  );
  await usage.select(first, context, selected);
  await usage.select(second, context, selected);
  usage.observe(
    {
      type: "response.created",
      response: { id: "first", model: "real-model" },
    },
    3000,
  );
  usage.observe(
    {
      type: "response.created",
      response: { id: "second", model: "real-model" },
    },
    3001,
  );
  usage.observe(
    {
      type: "response.completed",
      response: { id: "second", reasoning: { effort: "low" } },
    },
    4000,
  );
  usage.observe(
    {
      type: "response.completed",
      response: { id: "first", reasoning: { effort: "low" } },
    },
    5000,
  );
  assert.deepEqual(compareUpstream(first.checkpoint().upstream_observation), {
    model: "match",
    reasoning: "mismatch",
    differences: [{ field: "effort", requested: "high", returned: "low" }],
  });
  assert.deepEqual(compareUpstream(second.checkpoint().upstream_observation), {
    model: "match",
    reasoning: "match",
    differences: [],
  });
});
