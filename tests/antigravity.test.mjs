import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config/store.ts";
import { z } from "zod";
import {
  configurationSchema,
  draftConfigurationSchema,
  maskedConfigurationSchema,
} from "../src/config/schema.ts";
import { antigravityAdapter } from "../src/providers/antigravity/index.ts";
import { configureLogging } from "../src/shared/log.ts";
import {
  AntigravityClient,
  ANTIGRAVITY_BASE,
  ANTIGRAVITY_USER_AGENT,
  authorizationUrl,
  parseQuota,
  parseModels,
  parseSubscription,
} from "../src/providers/antigravity/api.ts";
import {
  translateRequest,
  nativeSchema,
} from "../src/providers/antigravity/request.ts";
import {
  convertResponse,
  translatedUsage,
} from "../src/providers/antigravity/response.ts";
import { aggregateCodexModels } from "../src/gateway/catalog/models.ts";
import { retryResponseUsage } from "../src/telemetry/retry.ts";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ref = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = {
  provider_id: "antigravity",
  account_ref: ref,
  client_id: "client",
  model: "native-model",
};

test("native request discriminants reject objects instead of coercing them to strings", async () => {
  for (const [payload, message] of [
    [
      { input: "hello", tools: [{ type: {}, name: "bad" }] },
      /tool type must be a string/,
    ],
    [
      { input: [{ type: {}, role: "user", content: "hello" }] },
      /Responses input type must be a string/,
    ],
    [
      { input: [{ role: "user", content: [{ type: {}, text: "hello" }] }] },
      /content type must be a string/,
    ],
    [
      { input: "hello", reasoning: { effort: {} } },
      /reasoning effort must be a string/,
    ],
    [
      { input: "hello", output_config: { effort: ["high"] } },
      /reasoning effort must be a string/,
    ],
  ]) {
    await assert.rejects(
      translateRequest(payload, "responses", scope, key),
      message,
    );
  }
});
function config() {
  return parseConfig({
    providers: [
      {
        type: "antigravity",
        id: "antigravity",
        models: ["native-model"],
        priority: 100,
        disabled: false,
        credentials: [
          {
            id: "one",
            auth: { type: "oauth", account_ref: ref },
            priority: 100,
            disabled: false,
          },
        ],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client-key", providers: ["antigravity"] },
    ],
  });
}
const native = (
  parts,
  finishReason = "STOP",
  usageMetadata = {
    promptTokenCount: 20,
    candidatesTokenCount: 5,
    thoughtsTokenCount: 3,
    cachedContentTokenCount: 4,
  },
) => ({
  response: {
    candidates: [
      {
        content: { role: "model", parts },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
    usageMetadata,
  },
});
const options = (protocol, stream = false, tools = []) => ({
  protocol,
  stream,
  tools,
  key,
  scope,
  model: "client-alias",
});
function sse(values, fragmented = false) {
  const text = values
    .map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index >= bytes.length) {
          controller.close();
          return;
        }
        const end = fragmented ? index + 7 : bytes.length;
        controller.enqueue(bytes.slice(index, end));
        index = end;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const events = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) =>
      JSON.parse(
        frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6),
      ),
    );

test("Antigravity has a reserved identity and may only appear once", () => {
  const value = config();
  for (const schema of [configurationSchema, draftConfigurationSchema]) {
    const renamed = structuredClone(value);
    renamed.providers[0].id = "another-antigravity";
    assert.equal(schema.safeParse(renamed).success, false);
    assert.throws(
      () =>
        schema.parse({
          ...value,
          providers: [...value.providers, ...value.providers],
        }),
      /Antigravity is a fixed provider/,
    );
    const reserved = structuredClone(value);
    reserved.providers[0] = {
      ...reserved.providers[0],
      type: "ai_gateway",
      base_url: "https://example.test",
      credentials: [
        {
          id: "key",
          auth: { type: "api_key", api_key: "upstream-key" },
          priority: 100,
          disabled: false,
        },
      ],
    };
    assert.throws(() => schema.parse(reserved), /reserved provider ID/);
  }
});

test("disabled Antigravity can be published before accounts and models are ready", () => {
  const value = config();
  const provider = value.providers[0];
  provider.disabled = true;
  provider.models = [];
  provider.credentials = [];
  assert.deepEqual(parseConfig(value), value);
  assert.deepEqual(draftConfigurationSchema.parse(value), value);
  assert.deepEqual(maskedConfigurationSchema.parse(value), value);
  provider.disabled = false;
  assert.throws(() => parseConfig(value), /select Antigravity models/);
  assert.deepEqual(draftConfigurationSchema.parse(value), value);
  assert.deepEqual(maskedConfigurationSchema.parse(value), value);
  provider.models = ["native-model"];
  assert.throws(() => parseConfig(value), /add an Antigravity account/);
});

test("JSON Schema exposes native singleton, reserved ID and readiness rules", () => {
  const schema = z.toJSONSchema(configurationSchema, {
    io: "input",
    target: "draft-2020-12",
  });
  const providers = schema.properties.providers;
  assert.equal(providers.minContains, 0);
  assert.equal(providers.maxContains, 1);
  assert.equal(providers.contains.properties.type.const, "antigravity");
  const gateway = providers.items.oneOf.find(
    (entry) => entry.properties.type.const === "ai_gateway",
  );
  const native = providers.items.oneOf.find(
    (entry) => entry.properties.type.const === "antigravity",
  );
  assert.deepEqual(gateway.properties.id.not, { const: "antigravity" });
  assert.equal(native.properties.id.const, "antigravity");
  assert.equal(native.properties.models.minItems ?? 0, 0);
  assert.equal(native.properties.credentials.minItems ?? 0, 0);
  assert.deepEqual(native.if, {
    properties: { disabled: { const: false } },
    required: ["disabled"],
  });
  assert.deepEqual(native.then.properties, {
    models: { minItems: 1 },
    credentials: { minItems: 1 },
  });
  assert.equal(gateway.properties.models.minItems, 1);
  assert.equal(gateway.properties.credentials.minItems, 1);
  assert.equal(gateway.properties.models.uniqueItems, true);
  assert.equal(native.properties.models.uniqueItems, true);
});

test("Antigravity configuration accepts only implemented OAuth accounts and capabilities", () => {
  const value = config();
  assert.equal(value.providers[0].supports_websocket, false);
  for (const mutate of [
    (p) => {
      p.base_url = "https://not-official.example";
    },
    (p) => {
      p.type = "claude";
    },
    (p) => {
      p.protocol = "anthropic";
    },
    (p) => {
      p.credentials[0].auth = { type: "api_key", api_key: "no" };
    },
    (p) => {
      p.credentials[0].auth.refresh_token = "never-in-config";
    },
    (p) => {
      p.credentials[0].auth.account_ref = "not-a-uuid";
    },
    (p) => {
      p.credentials.push({ ...p.credentials[0], id: "two" });
    },
    (p) => {
      p.supports_websocket = true;
    },
    (p) => {
      p.supports_context_management = true;
    },
    (p) => {
      p.supports_web_search = true;
    },
    (p) => {
      p.anthropic_1m_context = true;
    },
    (p) => {
      p.emulate_claude_code = true;
    },
  ]) {
    const copy = structuredClone(value);
    mutate(copy.providers[0]);
    assert.throws(() => parseConfig(copy));
  }
  for (const endpoint of [
    "responses",
    "messages",
    "messages/count_tokens",
    "models",
  ])
    assert.equal(
      antigravityAdapter.supports(value.providers[0], endpoint, "http"),
      true,
    );
  for (const endpoint of [
    "chat/completions",
    "responses/compact",
    "alpha/search",
  ])
    assert.equal(
      antigravityAdapter.supports(value.providers[0], endpoint, "http"),
      false,
    );
  assert.equal(
    antigravityAdapter.supports(value.providers[0], "responses", "websocket"),
    false,
  );
});

test("OAuth API uses the built-in desktop registration, injected transport and PKCE", async () => {
  const requests = [];
  const client = new AntigravityClient(async (request) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: new Headers(request.headers),
      text: request.body ? await request.text() : "",
    });
    if (request.url.includes("/token"))
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      });
    if (request.url.includes("userinfo"))
      return Response.json({ id: "google-id", email: "user@example.test" });
    return Response.json({ models: {} });
  });
  await client.exchange("code", "verifier");
  await client.refresh("refresh");
  await client.userInfo("access");
  await client.load("access");
  await client.onboard("access", "free-tier");
  await client.models("access", "project");
  await client.quota("access", "project");
  assert.equal(requests.length, 7);
  const url = new URL(authorizationUrl("random-state", "challenge"));
  const clientId =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
  assert.equal(url.searchParams.get("client_id"), clientId);
  for (const request of requests.slice(0, 2)) {
    const fields = new URLSearchParams(request.text);
    assert.equal(request.url, "https://oauth2.googleapis.com/token");
    assert.equal(request.method, "POST");
    assert.equal(fields.get("client_id"), clientId);
    assert.equal(
      fields.get("client_secret"),
      "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",
    );
  }
  const token = new URLSearchParams(requests[0].text);
  assert.equal(token.get("grant_type"), "authorization_code");
  assert.equal(token.get("code_verifier"), "verifier");
  assert.equal(
    token.get("redirect_uri"),
    "http://localhost:51121/oauth-callback",
  );
  const refresh = new URLSearchParams(requests[1].text);
  assert.equal(refresh.get("grant_type"), "refresh_token");
  assert.equal(refresh.get("refresh_token"), "refresh");
  assert.ok(
    requests
      .slice(2)
      .every(
        (request) => request.headers.get("authorization") === "Bearer access",
      ),
  );
  assert.equal(url.searchParams.get("state"), "random-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge");
  assert.equal(url.searchParams.get("scope").split(" ").length, 5);
  const [identity, load, onboard, models, quota] = requests.slice(2);
  assert.equal(identity.headers.get("user-agent"), ANTIGRAVITY_USER_AGENT);
  assert.equal(load.headers.get("accept"), "*/*");
  assert.equal(load.headers.get("user-agent"), ANTIGRAVITY_USER_AGENT);
  assert.equal(load.headers.get("x-goog-api-client"), null);
  assert.equal(
    load.text,
    JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  );
  assert.equal(onboard.url, `${ANTIGRAVITY_BASE}/v1internal:onboardUser`);
  assert.equal(onboard.headers.get("accept"), "*/*");
  assert.equal(
    onboard.headers.get("user-agent"),
    `${ANTIGRAVITY_USER_AGENT} google-api-nodejs-client/10.3.0`,
  );
  assert.equal(onboard.headers.get("x-goog-api-client"), "gl-node/22.21.1");
  assert.equal(
    onboard.text,
    JSON.stringify({
      tier_id: "free-tier",
      metadata: {
        ide_type: "ANTIGRAVITY",
        ide_name: "antigravity",
        ide_version: "2.9.1",
      },
    }),
  );
  assert.equal(models.headers.get("user-agent"), ANTIGRAVITY_USER_AGENT);
  assert.equal(quota.headers.get("user-agent"), ANTIGRAVITY_USER_AGENT);
});

test("quota fallback is limited to explicit unsupported statuses, including plain-text errors", async () => {
  for (const status of [404, 405, 501, 401, 403, 429, 500]) {
    const urls = [];
    const client = new AntigravityClient(async (request) => {
      urls.push(request.url);
      return urls.length === 1
        ? new Response("unsupported", { status })
        : Response.json({ models: {} });
    });
    if ([404, 405, 501].includes(status)) {
      assert.deepEqual(await client.quota("access", "project"), { models: {} });
      assert.equal(urls.length, 2);
    } else {
      await assert.rejects(
        client.quota("access", "project"),
        (error) => error.status === status,
      );
      assert.equal(urls.length, 1);
    }
  }
});

test("OAuth upstream failures log only operation, status and safe endpoint", async () => {
  const original = console.warn;
  const entries = [];
  console.warn = (entry) => entries.push(entry);
  try {
    configureLogging("warn");
    const client = new AntigravityClient(
      async () =>
        new Response("The caller does not have permission", { status: 403 }),
    );
    await assert.rejects(
      client.load("private-access"),
      (error) => error.status === 403,
    );
  } finally {
    console.warn = original;
    configureLogging("info");
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation, "loadCodeAssist");
  assert.equal(entries[0].status, 403);
  assert.equal(
    entries[0].url,
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  );
  assert.doesNotMatch(JSON.stringify(entries), /private-access/);
});

test("model and quota parsing retain unknown fields as unknown, not fake zero quotas", () => {
  assert.deepEqual(
    parseQuota({
      groups: [
        {
          displayName: "Gemini",
          buckets: [{ window: "weekly", remainingFraction: "0.7" }, {}],
        },
      ],
    })[0].buckets.map((b) => b.remaining_fraction),
    [0.7, null],
  );
  assert.equal(
    parseQuota({
      models: { gemini: { quotaInfo: { resetTime: "2026-10-01T00:00:00Z" } } },
    })[0].buckets[0].remaining_fraction,
    null,
  );
  assert.equal(
    parseModels({
      models: { real: { displayName: "Real model", inputTokenLimit: 1000 } },
    })[0].output_token_limit,
    null,
  );
  assert.equal(
    parseSubscription({
      paidTier: {
        id: "pro",
        name: "Pro",
        availableCredits: [{ creditType: "credits", creditAmount: "24" }],
      },
    }).credits[0].amount,
    "24",
  );
});

test("request translation covers system, images, tools, schemas and reasoning without rewriting values", async () => {
  const input = {
    model: "alias",
    instructions: "System guidance",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
      {
        type: "function_call",
        name: "inspect",
        call_id: "one",
        arguments: '{"const":"keep","properties":{"default":"keep"}}',
      },
      {
        type: "function_call_output",
        call_id: "one",
        output: [{ type: "input_text", text: '{"$ref":"literal data"}' }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "inspect",
        parameters: {
          type: "object",
          properties: {
            const: { const: "only", default: "discard" },
            data: { $ref: "#/$defs/value" },
          },
          $defs: { value: { type: "string" } },
        },
      },
    ],
    text: {
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    },
    reasoning: { effort: "high" },
    max_output_tokens: 200,
  };
  const before = structuredClone(input);
  const result = await translateRequest(
    input,
    "responses",
    scope,
    key,
    "session",
  );
  assert.deepEqual(input, before);
  assert.deepEqual(result.request.systemInstruction.parts, [
    { text: "System guidance" },
  ]);
  assert.deepEqual(result.request.contents[0].parts[1], {
    inlineData: { mimeType: "image/png", data: "AAAA" },
  });
  assert.deepEqual(result.request.contents[1].parts[0].functionCall.args, {
    const: "keep",
    properties: { default: "keep" },
  });
  assert.deepEqual(
    result.request.contents[2].parts[0].functionResponse.response.output,
    before.input[2].output,
  );
  assert.deepEqual(
    result.request.tools[0].functionDeclarations[0].parametersJsonSchema
      .properties,
    { const: { enum: ["only"] }, data: { type: "string" } },
  );
  assert.equal(
    result.request.generationConfig.responseMimeType,
    "application/json",
  );
  assert.equal(
    result.request.generationConfig.thinkingConfig.thinkingBudget,
    16384,
  );
  assert.match(result.request.sessionId, /^\d+$/);
  const other = await translateRequest(
    input,
    "responses",
    { ...scope, client_id: "other" },
    key,
    "session",
  );
  assert.notEqual(other.request.sessionId, result.request.sessionId);
  assert.throws(
    () =>
      nativeSchema({
        $ref: "#/$defs/loop",
        $defs: { loop: { $ref: "#/$defs/loop" } },
      }),
    /recursive reference/,
  );
});

for (const protocol of ["openai", "anthropic"]) {
  test(`${protocol} plain response, tool correlation and signed reasoning survive stateless replay`, async () => {
    const parts = [
      {
        thought: true,
        text: "Brief reasoning",
        thoughtSignature: "private-thought-signature",
      },
      {
        text: "Calling tools",
        thought: false,
        thoughtSignature: "private-text-signature",
      },
      {
        functionCall: {
          name: "inspect",
          args: { b: 2, a: { const: "unchanged" } },
        },
        thoughtSignature: "private-call-signature",
      },
      {
        functionCall: {
          name: "inspect",
          args: { path: "second" },
          id: "native-id",
        },
        thoughtSignature: "private-second-signature",
      },
    ];
    const response = await (
      await convertResponse(Response.json(native(parts)), options(protocol))
    ).json();
    const output = protocol === "openai" ? response.output : response.content;
    assert.equal(
      JSON.stringify(response).includes("private-call-signature"),
      false,
    );
    const calls = output.filter(
      (item) =>
        item.type === (protocol === "openai" ? "function_call" : "tool_use"),
    );
    assert.equal(calls.length, 2);
    const ids = calls.map((item) => item.call_id ?? item.id);
    assert.equal(ids[1], "native-id");
    const payload =
      protocol === "openai"
        ? {
            model: "alias",
            input: [
              { role: "user", content: "start" },
              ...output,
              ...ids.map((id) => ({
                type: "function_call_output",
                call_id: id,
                output: [{ type: "input_text", text: "value" }],
              })),
            ],
          }
        : {
            model: "alias",
            messages: [
              { role: "user", content: "start" },
              { role: "assistant", content: output },
              {
                role: "user",
                content: ids.map((id) => ({
                  type: "tool_result",
                  tool_use_id: id,
                  content: [{ type: "text", text: "value" }],
                })),
              },
            ],
          };
    const endpoint = protocol === "openai" ? "responses" : "messages";
    const replayed = await translateRequest(payload, endpoint, scope, key);
    assert.deepEqual(replayed.request.contents[1].parts, parts);
    assert.equal(
      replayed.request.contents[2].parts[0].functionResponse.id,
      undefined,
    );
    assert.equal(
      replayed.request.contents[2].parts[1].functionResponse.id,
      "native-id",
    );
    assert.equal(
      replayed.request.contents[2].parts[0].functionResponse.response.output[0]
        .text,
      "value",
    );
    assert.equal(
      protocol === "openai"
        ? response.usage.input_tokens
        : response.usage.input_tokens + response.usage.cache_read_input_tokens,
      20,
    );
    assert.equal(response.usage.output_tokens, 8);
    for (const field of ["client_id", "account_ref", "model", "provider_id"])
      await assert.rejects(
        translateRequest(
          payload,
          endpoint,
          { ...scope, [field]: "another" },
          key,
        ),
        /does not belong/,
      );
    const changed = structuredClone(payload);
    const changedOutput =
      protocol === "openai"
        ? changed.input.slice(1)
        : changed.messages[1].content;
    if (protocol === "openai") changedOutput[0].summary[0].text = "tampered";
    else changedOutput[0].thinking = "tampered";
    await assert.rejects(
      translateRequest(changed, endpoint, scope, key),
      /Signed thinking content changed/,
    );
    const modifiedCall = structuredClone(payload);
    const callOutput =
      protocol === "openai"
        ? modifiedCall.input.find((item) => item.type === "function_call")
        : modifiedCall.messages[1].content.find(
            (item) => item.type === "tool_use",
          );
    if (protocol === "openai")
      callOutput.arguments = '{"b":2,"a":{"const":"modified"}}';
    else callOutput.input.a.const = "modified";
    await assert.rejects(
      translateRequest(modifiedCall, endpoint, scope, key),
      /Signed assistant content changed/,
    );
  });

  test(`${protocol} fragmented SSE emits ordered deltas, usage, signatures and one terminal event`, async () => {
    const upstream = sse(
      [
        native([{ thought: true, text: "想" }], null, { promptTokenCount: 20 }),
        native(
          [{ thought: true, text: "好", thoughtSignature: "s" }],
          null,
          {},
        ),
        native([{ text: "Hello " }], null, {}),
        native([{ text: "world" }], "STOP"),
      ],
      true,
    );
    const response = await convertResponse(upstream, options(protocol, true));
    const output = events(await response.text());
    assert.equal(
      output[0].type,
      protocol === "openai" ? "response.created" : "message_start",
    );
    assert.equal(
      output.at(-1).type,
      protocol === "openai" ? "response.completed" : "message_stop",
    );
    assert.equal(
      output.filter((event) => event.type === output.at(-1).type).length,
      1,
    );
    if (protocol === "openai") {
      assert.deepEqual(
        output.map((event) => event.sequence_number),
        output.map((_, index) => index),
      );
      assert.equal(
        output
          .filter((e) => e.type === "response.output_text.delta")
          .map((e) => e.delta)
          .join(""),
        "Hello world",
      );
      assert.equal(output.at(-1).response.output[0].summary[0].text, "想好");
      assert.equal(output.at(-1).response.usage.output_tokens, 8);
    } else {
      const starts = output.filter((e) => e.type === "content_block_start");
      assert.deepEqual(
        starts.map((e) => e.index),
        [0, 1],
      );
      assert.equal(
        output.filter((e) => e.type === "content_block_stop").length,
        2,
      );
      assert.ok(output.some((e) => e.delta?.type === "signature_delta"));
      assert.equal(output.at(-2).usage.output_tokens, 8);
    }
  });

  test(`${protocol} partial streams, truncation and HTTP errors retain the client dialect`, async () => {
    const broken = await convertResponse(
      sse([native([{ text: "partial" }], null)]),
      options(protocol, true),
    );
    const output = events(await broken.text());
    assert.equal(
      output.at(-1).type,
      protocol === "openai" ? "response.failed" : "error",
    );
    const limited = await (
      await convertResponse(
        Response.json(native([{ text: "limited" }], "MAX_TOKENS")),
        options(protocol),
      )
    ).json();
    assert.equal(
      protocol === "openai" ? limited.status : limited.stop_reason,
      protocol === "openai" ? "incomplete" : "max_tokens",
    );
    const error = await convertResponse(
      new Response("upstream private text", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
      options(protocol),
    );
    assert.equal(error.status, 429);
    assert.equal(error.headers.get("retry-after"), "30");
    const body = await error.json();
    assert.equal(
      body.error.type,
      protocol === "openai" ? "rate_limit_error" : "rate_limit_error",
    );
    if (protocol === "anthropic") assert.equal(body.error.code, undefined);
  });
}

test(
  "stream cancellation closes a stalled upstream reader promptly",
  { timeout: 2000 },
  async () => {
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(native([{ text: "start" }], null))}\n\n`,
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const response = await convertResponse(upstream, options("openai", true));
    const reader = response.body.getReader();
    for (let i = 0; i < 5; i++) assert.equal((await reader.read()).done, false);
    const pending = reader.read();
    await reader.cancel();
    assert.equal((await pending).done, true);
    assert.equal(cancelled, true);
  },
);

test("signature-only native parts retain their associated content and order", async () => {
  const output = await (
    await convertResponse(
      Response.json(
        native([{ text: "signed" }, { thoughtSignature: "late-signature" }]),
      ),
      options("openai"),
    )
  ).json();
  const replayed = await translateRequest(
    { input: [{ role: "user", content: "start" }, ...output.output] },
    "responses",
    scope,
    key,
  );
  assert.deepEqual(replayed.request.contents[1].parts, [
    { text: "signed", thoughtSignature: "late-signature" },
  ]);
});

test("namespace and custom tool names round-trip without corrupting input", async () => {
  const tools = [
    {
      type: "namespace",
      name: "files",
      tools: [{ type: "custom", name: "apply_patch" }],
    },
  ];
  const request = await translateRequest(
    { input: "edit", tools },
    "responses",
    scope,
    key,
  );
  const name = request.tools[0].native;
  assert.notEqual(name, "files.apply_patch");
  const result = await (
    await convertResponse(
      Response.json(
        native([
          {
            functionCall: {
              name,
              args: { input: "*** Begin Patch\nconst literal\n*** End Patch" },
            },
            thoughtSignature: "sig",
          },
        ]),
      ),
      options("openai", false, request.tools),
    )
  ).json();
  assert.equal(result.output[0].type, "custom_tool_call");
  assert.equal(result.output[0].namespace, "files");
  const replay = await translateRequest(
    { input: [{ role: "user", content: "edit" }, ...result.output], tools },
    "responses",
    scope,
    key,
  );
  assert.equal(replay.request.contents[1].parts[0].functionCall.name, name);
});

test(
  "token counting uses the native countTokens envelope and honors cancellation",
  { timeout: 2000 },
  async () => {
    const value = config();
    const cancellation = new AbortController();
    const prepared = await antigravityAdapter.prepare(
      value.providers[0],
      {
        type: "oauth",
        account_ref: ref,
        token: "access",
        project_id: "project",
      },
      {
        endpoint: "messages/count_tokens",
        transport: "http",
        protocol: "anthropic",
        request: new Request("https://gateway/v1/messages/count_tokens", {
          signal: cancellation.signal,
          headers: {
            "x-api-key": "client-key",
            "anthropic-version": "2023-06-01",
          },
        }),
        payload: {
          model: "native-model",
          messages: [{ role: "user", content: "count" }],
          tools: [{ name: "tool", input_schema: { type: "object" } }],
        },
        model: "native-model",
        clientId: "client",
        sessionId: "session",
      },
      { config: value, env: { CONFIG_ENCRYPTION_KEY: key } },
    );
    assert.ok(prepared.url.endsWith(":countTokens"));
    assert.equal(prepared.method, "POST");
    const body = JSON.parse(prepared.body);
    assert.equal(body.project, undefined);
    assert.equal(body.model, undefined);
    assert.equal(body.request.sessionId, undefined);
    assert.equal(body.request.toolConfig, undefined);
    assert.equal(prepared.headers.get("x-api-key"), null);
    assert.deepEqual(
      await (
        await prepared.transformResponse(Response.json({ totalTokens: 42 }))
      ).json(),
      { input_tokens: 42 },
    );
    let cancelled = false;
    const response = prepared.transformResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"totalTokens":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    cancellation.abort(new Error("Client cancelled token counting"));
    await assert.rejects(response, /cancelled token counting/);
    assert.equal(cancelled, true);
  },
);

test("native models and aliases appear in Codex without advertising Astra capabilities", () => {
  const metadata = [
    {
      id: "gemini-real",
      context_window: 1000000,
      max_output_tokens: 32000,
      display_name: "Gemini real",
    },
    { id: "gpt-6-astra", context_window: 200000 },
  ];
  const models = aggregateCodexModels(
    new Set(["gemini-real", "gpt-6-astra"]),
    new Set(),
    metadata,
  );
  assert.equal(models.length, 2);
  assert.equal(models[0].slug, "gemini-real");
  assert.equal(models[0].context_window, 1000000);
  assert.equal(models[1].supports_experimental_context, false);
  assert.equal(models[1].model_messages, undefined);
  assert.equal(
    aggregateCodexModels(new Set(["other"]), new Set(), metadata).length,
    0,
  );
});

test("native retry usage is normalized without consuming the final response path", async () => {
  const response = Response.json(native([], "STOP"), { status: 503 });
  const usage = await retryResponseUsage(response, "openai", (value) =>
    translatedUsage(value, "openai"),
  );
  assert.equal(usage.tokens.input_tokens, 20);
  assert.equal(usage.tokens.output_tokens, 8);
  assert.equal(usage.tokens.reasoning_tokens, 3);
});

test("schema expansion is bounded even for wide acyclic reference graphs", () => {
  const defs = { leaf: { type: "string" } };
  for (let index = 0; index < 20; index++) {
    const child = index ? `level${index - 1}` : "leaf";
    defs[`level${index}`] = {
      type: "object",
      properties: {
        a: { $ref: `#/$defs/${child}` },
        b: { $ref: `#/$defs/${child}` },
      },
    };
  }
  assert.throws(
    () => nativeSchema({ $defs: defs, $ref: "#/$defs/level19" }),
    /too large|too deeply nested/,
  );
  assert.equal(translatedUsage({ usageMetadata: {} }, "openai"), undefined);
});

test("native SSE error codes are mapped into the Messages error set", async () => {
  const response = await convertResponse(
    sse([
      native([{ text: "partial" }], null),
      { error: { code: 429, message: "private details" } },
    ]),
    options("anthropic", true),
  );
  const output = events(await response.text());
  assert.equal(output.at(-1).error.type, "rate_limit_error");
  assert.equal(JSON.stringify(output).includes("private details"), false);
});

test(
  "cancelling SSE conversion also interrupts a stalled upstream JSON response",
  { timeout: 2000 },
  async () => {
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"response":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const response = await convertResponse(upstream, options("openai", true));
    const reader = response.body.getReader();
    const pending = reader.read();
    await new Promise((resolve) => setImmediate(resolve));
    await reader.cancel();
    assert.equal((await pending).done, true);
    assert.equal(cancelled, true);
  },
);

test("Gemini 3 levels and Claude budget/tool modes follow their native dialects", async () => {
  const gemini = await translateRequest(
    { input: "hi", reasoning: { effort: "xhigh" } },
    "responses",
    { ...scope, model: "gemini-3.1-pro-low" },
    key,
  );
  assert.deepEqual(gemini.request.generationConfig.thinkingConfig, {
    thinkingLevel: "high",
    includeThoughts: true,
  });
  for (const max_tokens of [512, 2048]) {
    const claude = await translateRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 8192 },
        max_tokens,
        tools: [{ name: "tool", input_schema: { type: "object" } }],
      },
      "messages",
      { ...scope, model: "claude-sonnet-4-6" },
      key,
    );
    assert.equal(claude.request.generationConfig.maxOutputTokens, max_tokens);
    assert.equal(
      claude.request.generationConfig.thinkingConfig?.thinkingBudget,
      max_tokens === 512 ? undefined : max_tokens - 1,
    );
    assert.equal(
      claude.request.toolConfig.functionCallingConfig.mode,
      "VALIDATED",
    );
  }
  const adaptive = await translateRequest(
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      tool_choice: { type: "none" },
    },
    "messages",
    { ...scope, model: "claude-sonnet-4-6" },
    key,
  );
  assert.equal(
    adaptive.request.generationConfig.thinkingConfig.thinkingBudget,
    -1,
  );
  assert.equal(adaptive.request.toolConfig.functionCallingConfig.mode, "NONE");
  await assert.rejects(
    translateRequest(
      { input: "hi", max_output_tokens: -1 },
      "responses",
      scope,
      key,
    ),
    /positive integer/,
  );
  await assert.rejects(
    translateRequest(
      { input: "hi", thinking: { type: "enabled", budget_tokens: 1.5 } },
      "responses",
      scope,
      key,
    ),
    /non-negative integer/,
  );
});
