import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config/store.ts";
import { draftConfigurationSchema } from "../src/config/schema.ts";
import { translateRequest } from "../src/providers/xai/request.ts";
import { convertResponse } from "../src/providers/xai/response.ts";
import { openReasoning, sealReasoning } from "../src/providers/xai/replay.ts";
import { parseBilling } from "../src/providers/xai/billing.ts";
import { quotaAvailability, xaiLimit } from "../src/providers/xai/limits.ts";
import { inspectXaiResponse } from "../src/providers/xai/inspect.ts";
import { officialOAuthUrl, XaiClient } from "../src/providers/xai/api.ts";
import { prepareProviderRequest } from "../src/providers/index.ts";
import { estimateInputTokens } from "../src/providers/xai/tokens.ts";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ref = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = {
  provider_id: "xai",
  account_ref: ref,
  client_id: "client",
  model: "grok-4.7",
};
const config = (extra = {}) =>
  parseConfig({
    providers: [
      {
        type: "xai",
        id: "xai",
        priority: 100,
        disabled: false,
        models: [scope.model],
        credentials: [
          {
            id: "a",
            auth: { type: "oauth", account_ref: ref },
            priority: 100,
            disabled: false,
          },
        ],
        ...extra,
      },
    ],
    api_keys: [{ id: "client", api_key: "secret", providers: ["xai"] }],
  });
function stream(events) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const options = (anthropic = false, streaming = false, tools = []) => ({
  anthropic,
  stream: streaming,
  model: "alias",
  scope,
  key,
  tools,
});
const message = {
  type: "message",
  id: "msg",
  role: "assistant",
  content: [{ type: "output_text", text: "Hello", annotations: [] }],
};
const completed = {
  type: "response.completed",
  response: {
    id: "resp",
    status: "completed",
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 5,
    },
  },
};
const textEvents = [
  { type: "response.created", response: { id: "resp" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...message, content: [] },
  },
  {
    type: "response.output_text.delta",
    output_index: 0,
    item_id: "msg",
    delta: "Hello",
  },
  { type: "response.output_item.done", output_index: 0, item: message },
  completed,
];
test("xAI configuration is an OAuth singleton with disabled drafts", () => {
  const c = config();
  assert.equal(c.providers[0].account_selection, "round_robin");
  assert.equal(c.providers[0].allow_extra_usage, false);
  for (const value of [
    { id: "other" },
    { base_url: "https://example.test" },
    { supports_websocket: true },
    { supports_web_search: true },
    { protocol: "openai" },
    { credentials: [] },
    {
      credentials: [
        {
          id: "a",
          priority: 1,
          disabled: false,
          auth: { type: "api_key", api_key: "bad" },
        },
      ],
    },
  ])
    assert.throws(() => config(value));
  const draft = structuredClone(c);
  draft.providers[0].credentials = [];
  assert.equal(draftConfigurationSchema.safeParse(draft).success, true);
  c.providers.push(c.providers[0]);
  assert.throws(() => parseConfig(c));
  assert.equal(
    config({ disabled: true, models: [], credentials: [] }).providers[0]
      .disabled,
    true,
  );
});
test("xAI local models and estimated counts do not resolve OAuth", async () => {
  const c = config();
  for (const endpoint of ["models", "messages/count_tokens"]) {
    const result = await prepareProviderRequest(
      c.providers[0],
      c.providers[0].credentials[0],
      {
        request: new Request("https://gateway.test"),
        endpoint,
        transport: "http",
        protocol: "anthropic",
        payload: { messages: [{ role: "user", content: "Hello world" }] },
      },
    );
    assert.equal(result.kind, "local");
    const body = await result.response.json();
    if (endpoint === "models") assert.equal(body.data[0].id, scope.model);
    else {
      assert.ok(body.input_tokens > 0);
      assert.equal(
        result.response.headers.get("x-cody-token-count"),
        "estimated-o200k_base",
      );
    }
  }
});
test("xAI request maps Messages images and tools without injecting instructions", async () => {
  const result = await translateRequest(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AA==" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call",
              name: "Read",
              input: { path: "/tmp" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call", content: "result" },
          ],
        },
      ],
      tools: [
        {
          name: "Read",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
      max_tokens: 123,
    },
    true,
    scope,
    key,
    [ref],
  );
  assert.equal(result.body.max_output_tokens, 123);
  assert.equal(result.body.instructions, undefined);
  assert.equal(
    result.body.input[0].content[1].image_url,
    "data:image/png;base64,AA==",
  );
  assert.equal(result.body.input[1].call_id, "call");
  assert.equal(result.body.input[1].arguments, '{"path":"/tmp"}');
  assert.equal(result.body.input[2].output, "result");
  for (const payload of [
    { input: "x", previous_response_id: "resp" },
    { input: "x", tools: [{ type: "web_search" }] },
    { input: "x", stop: ["end"] },
  ])
    await assert.rejects(translateRequest(payload, false, scope, key, [ref]));
});
test("xAI namespace folding and custom tools retain every declaration", async () => {
  const tools = [
    {
      type: "namespace",
      name: "app",
      tools: Array.from({ length: 205 }, (_, i) => ({
        type: "function",
        name: `tool${i}`,
        parameters: { type: "object" },
      })),
    },
  ];
  const result = await translateRequest(
    { input: "x", tools },
    false,
    scope,
    key,
    [ref],
  );
  assert.equal(result.tools.length, 205);
  assert.equal(result.body.tools.length, 1);
  assert.equal(
    result.body.tools[0].parameters.oneOf[204].properties.name.const,
    "tool204",
  );
  const custom = await translateRequest(
    { input: "x", tools: [{ type: "custom", name: "patch" }] },
    false,
    scope,
    key,
    [ref],
  );
  const response = await convertResponse(
    stream([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc",
          call_id: "call",
          name: custom.tools[0].wireName,
          arguments: '{"input":"patch text"}',
        },
      },
      completed,
    ]),
    options(false, false, custom.tools),
  );
  assert.equal((await response.json()).output[0].input, "patch text");
});
test("xAI streaming and nonstream output complete missing terminal output", async () => {
  for (const anthropic of [false, true]) {
    const response = await convertResponse(
      stream(textEvents),
      options(anthropic),
    );
    const body = await response.json();
    assert.equal(body.model, "alias");
    if (anthropic) {
      assert.equal(body.content[0].text, "Hello");
      assert.equal(body.usage.input_tokens, 16);
      assert.equal(body.stop_reason, "end_turn");
    } else assert.equal(body.output[0].content[0].text, "Hello");
    const sse = await (
      await convertResponse(stream(textEvents), options(anthropic, true))
    ).text();
    assert.match(sse, /Hello/);
    assert.match(sse, anthropic ? /message_stop/ : /response.completed/);
  }
});
test("xAI reasoning survives both dialects and rejects altered provenance", async () => {
  const native = {
    type: "reasoning",
    id: "rs",
    encrypted_content: "native-opaque",
    summary: [{ type: "summary_text", text: "Thinking" }],
  };
  const sealed = await sealReasoning(native, "Thinking", scope, key);
  assert.deepEqual(
    await openReasoning(
      sealed,
      "Thinking",
      { ...scope, account_ref: "second" },
      key,
      [ref, "second"],
    ),
    native,
  );
  for (const [target, visible, accounts] of [
    [{ ...scope, client_id: "other" }, "Thinking", [ref]],
    [{ ...scope, model: "other" }, "Thinking", [ref]],
    [scope, "changed", [ref]],
    [{ ...scope, account_ref: "other" }, "Thinking", [ref]],
  ])
    await assert.rejects(openReasoning(sealed, visible, target, key, accounts));
  for (const anthropic of [false, true]) {
    const result = await (
      await convertResponse(
        stream([
          { type: "response.output_item.done", output_index: 0, item: native },
          completed,
        ]),
        options(anthropic),
      )
    ).json();
    const item = anthropic ? result.content[0] : result.output[0];
    assert.match(
      anthropic ? item.signature : item.encrypted_content,
      /^cody-xai1\./,
    );
    const translated = await translateRequest(
      anthropic
        ? { messages: [{ role: "assistant", content: [item] }] }
        : { input: [item] },
      anthropic,
      scope,
      key,
      [ref],
    );
    assert.equal(translated.body.input[0].encrypted_content, "native-opaque");
  }
});
test("xAI incomplete is preserved and truncated streams never succeed", async () => {
  const response = await (
    await convertResponse(
      stream([
        ...textEvents.slice(0, -1),
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      options(true),
    )
  ).json();
  assert.equal(response.stop_reason, "max_tokens");
  await assert.rejects(
    convertResponse(stream(textEvents.slice(0, -1)), options()),
    /terminal/,
  );
  const output = await (
    await convertResponse(stream(textEvents.slice(0, -1)), options(true, true))
  ).text();
  assert.match(output, /event: error/);
  assert.doesNotMatch(output, /message_stop/);
});
test("xAI billing separates subscription and paid eligibility, failing closed on unknown", () => {
  const quota = parseBilling(
    {
      credit_usage_percent: 20,
      current_period: {
        type: "weekly",
        end: new Date(Date.now() + 60000).toISOString(),
      },
      on_demand_cap: { val: "100" },
      on_demand_used: { val: "10" },
    },
    { monthly_limit: 100, used: 100 },
  );
  assert.equal(quota.groups.length, 1);
  assert.equal(quotaAvailability(quota, scope.model).subscription, true);
  quota.groups[0].buckets[0].used_percent = 100;
  assert.equal(quotaAvailability(quota, scope.model).subscription, false);
  assert.equal(quotaAvailability(quota, scope.model).extra, true);
  assert.equal(
    quotaAvailability({ ...quota, stale: true }, scope.model).extra,
    false,
  );
  assert.throws(() => parseBilling({ on_demand_cap: 100 }));
  assert.equal(
    xaiLimit({ code: "rate_limit" }, new Headers(), scope.model),
    undefined,
  );
  assert.equal(
    xaiLimit(
      {
        code: "subscription:free-usage-exhausted",
        error: `Limit for ${scope.model}`,
      },
      new Headers(),
      scope.model,
      1000,
    ).resets_at,
    86401000,
  );
});
test("xAI prefix inspection switches only before visible output", async () => {
  const failure = {
    type: "error",
    code: "subscription:free-usage-exhausted",
    error: `Limit for ${scope.model}`,
  };
  const late = [];
  const inspected = await inspectXaiResponse(
    stream([{ type: "response.created", response: {} }, failure]),
    scope.model,
    async (limit) => late.push(limit),
    new AbortController().signal,
  );
  assert.ok(inspected.accountLimit);
  await inspected.response.text();
  assert.equal(late.length, 0);
  const after = await inspectXaiResponse(
    stream([textEvents[1], textEvents[2], failure]),
    scope.model,
    async (limit) => late.push(limit),
    new AbortController().signal,
  );
  assert.equal(after.accountLimit, undefined);
  await after.response.text();
  assert.equal(late.length, 1);
});
test("xAI OAuth endpoint validation and device slow_down", async () => {
  for (const url of [
    "http://auth.x.ai/token",
    "https://auth.x.ai.evil.test/token",
    "https://user:secret@auth.x.ai/token",
    "https://auth.x.ai:8443/token",
  ])
    assert.throws(() => officialOAuthUrl(url));
  const client = new XaiClient(
    async () => Response.json({ error: "slow_down" }, { status: 400 }),
    new AbortController().signal,
  );
  const result = await client.pollDevice({
    token_endpoint: "https://auth.x.ai/token",
    device_code: "d",
  });
  assert.equal(result.slow, true);
  assert.equal(result.tokens, null);
});

test("xAI partial refresh preserves omitted fields and rejects identity changes", async () => {
  const jwt = (sub) =>
    `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub, iss: "https://auth.x.ai" }))}.signature`;
  let subject = "same";
  const client = new XaiClient(
    async (request) =>
      request.url.endsWith("openid-configuration")
        ? Response.json({
            device_authorization_endpoint: "https://auth.x.ai/device",
            token_endpoint: "https://auth.x.ai/token",
          })
        : Response.json({ access_token: jwt(subject) }),
    new AbortController().signal,
  );
  const previous = {
    access_token: jwt("same"),
    id_token: jwt("same"),
    refresh_token: "refresh",
    expires_at: Date.now() + 30000,
  };
  const next = await client.refresh(previous, "same");
  assert.equal(next.refresh_token, previous.refresh_token);
  assert.equal(next.id_token, previous.id_token);
  assert.equal(next.expires_at, previous.expires_at);
  subject = "different";
  await assert.rejects(client.refresh(previous, "same"), /different account/);
});

test(
  "xAI stream cancellation cancels a pending upstream read",
  { timeout: 2000 },
  async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(textEvents[0])}\n\n`,
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const converted = await convertResponse(response, options(false, true));
    const reader = converted.body.getReader();
    await reader.read();
    await reader.read();
    const pendingRead = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reader.cancel();
    assert.equal((await pendingRead).done, true);
    assert.equal(cancelled, true);
  },
);

test("xAI local counts ignore image bytes and accept literal tokenizer markers", async () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: [{ type: "text", text: "literal <|endoftext|> result" }],
          },
        ],
      },
    ],
  };
  const count = await estimateInputTokens(payload);
  const withImage = structuredClone(payload);
  withImage.messages[0].content[0].content.push({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "AAAA".repeat(10000),
    },
  });
  assert.equal(await estimateInputTokens(withImage), count);
  assert.ok(count > 0);
  for (const invalid of [
    {},
    { messages: "invalid" },
    { messages: [{ role: "user", content: [{ type: "text", text: 42 }] }] },
  ])
    await assert.rejects(
      estimateInputTokens(invalid),
      /Invalid xAI request field/,
    );
});

test("xAI preserves tool errors and rejects unsupported or malformed controls", async () => {
  for (const result of [
    "Permission denied",
    [
      { type: "text", text: "Permission denied" },
      {
        type: "image",
        source: { type: "url", url: "https://example.test/error.png" },
      },
    ],
  ]) {
    const translated = await translateRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call",
                content: result,
                is_error: true,
              },
            ],
          },
        ],
      },
      true,
      scope,
      key,
      [ref],
    );
    const output = translated.body.input[0];
    assert.equal(output.call_id, "call");
    if (typeof result === "string")
      assert.deepEqual(JSON.parse(output.output), {
        is_error: true,
        content: result,
      });
    else {
      assert.equal(JSON.parse(output.output[0].text).is_error, true);
      assert.equal(
        output.output[2].image_url,
        "https://example.test/error.png",
      );
    }
  }
  for (const payload of [
    { input: "x", stream: "true" },
    { input: [{ role: "user", content: [{ type: "input_text", text: 42 }] }] },
    { input: "x", tools: [{ type: "function", name: "f", parameters: [] }] },
    {
      input: "x",
      tools: [
        {
          type: "custom",
          name: "f",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: /.+/",
          },
        },
      ],
    },
  ])
    await assert.rejects(
      translateRequest(payload, false, scope, key, [ref]),
      (error) => error.status === 400,
    );
  const strict = await translateRequest(
    {
      input: "x",
      tools: [
        {
          type: "function",
          name: "f",
          strict: true,
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
    false,
    scope,
    key,
    [ref],
  );
  assert.equal(strict.body.tools[0].strict, true);
  const disabled = await translateRequest(
    {
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
    },
    true,
    scope,
    key,
    [ref],
  );
  assert.deepEqual(disabled.body.reasoning, { effort: "none" });
});

test("xAI terminal-only output emits complete lifecycle events and ignores metadata", async () => {
  const events = [
    { type: "rate_limits.updated", rate_limits: [] },
    { ...completed, response: { ...completed.response, output: [message] } },
  ];
  for (const anthropic of [false, true]) {
    const sse = await (
      await convertResponse(stream(events), options(anthropic, true))
    ).text();
    for (const name of anthropic
      ? [
          "content_block_start",
          "text_delta",
          "content_block_stop",
          "message_stop",
        ]
      : [
          "response.output_item.added",
          "response.content_part.added",
          "response.output_text.delta",
          "response.content_part.done",
          "response.output_item.done",
          "response.completed",
        ])
      assert.ok(sse.includes(name), name);
    assert.match(sse, /Hello/);
    assert.doesNotMatch(sse, /event: error/);
  }
});

test("xAI malformed SSE fails closed and failed output never exposes raw reasoning", async () => {
  for (const event of [
    { type: "response.output_item.done", output_index: -1, item: message },
    { type: "response.completed", response: { output: [null] } },
  ])
    await assert.rejects(
      convertResponse(stream([event]), options()),
      /Invalid xAI SSE event/,
    );
  const raw = {
    type: "reasoning",
    id: "r",
    encrypted_content: "raw-secret",
    summary: [],
  };
  const failed = {
    type: "response.failed",
    response: { status: "failed", output: [raw] },
  };
  const sse = await (
    await convertResponse(
      stream([
        { type: "response.output_item.added", output_index: 0, item: raw },
        failed,
      ]),
      options(false, true),
    )
  ).text();
  assert.doesNotMatch(sse, /raw-secret/);
  assert.match(sse, /response.failed/);
  assert.equal(
    (await convertResponse(stream([failed]), options())).status,
    502,
  );
});

test("xAI 403 inspection consumes one bounded stream without a tee", async () => {
  let rejected = 0;
  const source = Response.json(
    { code: "auth:bad-credentials" },
    { status: 403 },
  );
  const inspected = await inspectXaiResponse(
    source,
    scope.model,
    async () => {},
    new AbortController().signal,
    async () => {
      rejected++;
    },
  );
  assert.equal(rejected, 1);
  assert.deepEqual(await inspected.response.json(), {
    code: "auth:bad-credentials",
  });
});

test("xAI refuses oversized schema expansion before serializing the upstream request", async () => {
  const parameters = {
    type: "object",
    $defs: { text: { type: "string", description: "x".repeat(1024 * 1024) } },
    properties: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `p${index}`,
        { $ref: "#/$defs/text" },
      ]),
    ),
  };
  await assert.rejects(
    translateRequest(
      { input: "x", tools: [{ type: "function", name: "f", parameters }] },
      false,
      scope,
      key,
      [ref],
    ),
    /Expanded tool schemas/,
  );
});

test("xAI refusal SSE retains the refusal content contract", async () => {
  const item = {
    ...message,
    content: [{ type: "refusal", refusal: "Cannot comply" }],
  };
  const sse = await (
    await convertResponse(
      stream([
        { ...completed, response: { ...completed.response, output: [item] } },
      ]),
      options(false, true),
    )
  ).text();
  assert.match(sse, /response.refusal.delta/);
  assert.match(sse, /response.refusal.done/);
  assert.doesNotMatch(sse, /response.output_text/);
  assert.match(sse, /"part":\{"type":"refusal"/);
});

test("xAI primary billing wins across field aliases and keeps subscription periods separate", () => {
  const primary = {
    creditUsagePercent: 30,
    currentPeriod: { type: "daily", end: "2030-01-02T00:00:00Z" },
    onDemandCap: 100,
    onDemandUsed: 90,
    usage: { includedUsed: 12 },
  };
  const legacy = {
    credit_usage_percent: 0,
    on_demand_cap: 1000,
    on_demand_used: 0,
    usage: { included_used: 0 },
    monthly_limit: 50,
    billing_period_end: "2030-02-01T00:00:00Z",
  };
  const quota = parseBilling(primary, legacy);
  assert.equal(quota.groups[0].buckets[0].window, "daily");
  assert.equal(quota.groups[0].buckets[0].used_percent, 30);
  assert.equal(quota.groups[0].buckets[0].reset_at, primary.currentPeriod.end);
  assert.equal(quota.xai_billing.billing_period_end, legacy.billing_period_end);
  assert.equal(quota.xai_billing.included_used, 12);
  assert.equal(quota.extra_usage.used_credits, 90);
  assert.equal(quota.extra_usage.monthly_limit, 100);
  assert.equal(parseBilling(primary).groups[0].buckets[0].used_percent, 30);
});
