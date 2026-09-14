import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialIsAvailable,
  ProviderHealthState,
} from "../src/gateway/health/health.ts";
import {
  aggregateCodexModels,
  aggregateStandardModels,
  clearModelsCacheForTests,
  handleModels,
  MAX_MODEL_CATALOG_BODY_BYTES,
  MODEL_CATALOG_CONCURRENCY,
  modelsFormatFor,
} from "../src/gateway/catalog/models.ts";

const results = [
  {
    provider: { id: "primary", models: ["grok-4.5"] },
    success: true,
    models: [
      {
        id: "grok-4.5",
        raw: { id: "grok-4.5", object: "model", owned_by: "newapi" },
      },
    ],
  },
];

test("standard aggregation adds a route without hiding the upstream model", () => {
  const models = aggregateStandardModels(
    results,
    new Map([["primary", { "gpt-5.6-sol": { model: "grok-4.5" } }]]),
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["grok-4.5", "gpt-5.6-sol"],
  );
});

test("standard aggregation honors route provider constraints", () => {
  const models = aggregateStandardModels(
    results,
    new Map([
      [
        "primary",
        { "gpt-5.6-sol": { model: "grok-4.5", providers: ["secondary"] } },
      ],
    ]),
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["grok-4.5"],
  );
});

test("a self-route hides a model supplied only by disallowed providers", () => {
  const routes = {
    "grok-4.5": { model: "grok-4.5", providers: ["secondary"] },
  };
  assert.deepEqual(
    aggregateStandardModels(results, new Map([["primary", routes]])),
    [],
  );

  const secondaryResults = [
    {
      ...results[0],
      provider: { id: "secondary", models: ["grok-4.5"] },
    },
  ];
  assert.deepEqual(
    aggregateStandardModels(
      secondaryResults,
      new Map([["secondary", routes]]),
    ).map((model) => model.id),
    ["grok-4.5"],
  );
});

test("standard aggregation resolves routes per provider", () => {
  const primaryResults = [
    {
      provider: { id: "primary", models: ["review-model", "grok-4.5"] },
      success: true,
      models: [
        {
          id: "review-model",
          raw: { id: "review-model", object: "model", owned_by: "primary" },
        },
        {
          id: "grok-4.5",
          raw: { id: "grok-4.5", object: "model", owned_by: "newapi" },
        },
      ],
    },
    {
      provider: { id: "secondary", models: ["grok-4.5"] },
      success: true,
      models: [
        {
          id: "grok-4.5",
          raw: { id: "grok-4.5", object: "model", owned_by: "newapi" },
        },
      ],
    },
  ];
  const models = aggregateStandardModels(
    primaryResults,
    new Map([
      ["primary", { "gpt-5.6-sol": { model: "review-model" } }],
      ["secondary", { "gpt-5.6-sol": { model: "grok-4.5" } }],
    ]),
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["review-model", "gpt-5.6-sol", "grok-4.5"],
  );
});

test("Codex aggregation only returns exact catalog matches", () => {
  const models = aggregateCodexModels(
    new Set(["grok-4.5", "gpt-5.6-sol", "codex-auto-review"]),
  );
  assert.deepEqual(
    models.map((model) => model.slug),
    ["gpt-5.6-sol", "codex-auto-review"],
  );
});

test("Anthropic clients receive the Anthropic model-list shape", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "model", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "x-api-key": "client",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.has_more, false);
    assert.equal(body.first_id, "model");
    assert.equal(body.last_id, "model");
    assert.deepEqual(
      body.data.map((entry) => entry.id),
      ["model"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic model entries carry the ModelInfo fields Claude requires", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.providers[0].models = ["grok-4.6", "gpt-5.6-sol"];
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      data: [
        { id: "grok-4.6", object: "model" },
        { id: "gpt-5.6-sol", object: "model" },
      ],
    });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "x-api-key": "client",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.data.map((entry) => entry.id),
      ["grok-4.6", "gpt-5.6-sol"],
    );
    const grok = body.data.find((entry) => entry.id === "grok-4.6");
    assert.equal(grok.type, "model");
    assert.equal(grok.display_name, "Grok 4.6");
    assert.equal(typeof grok.created_at, "string");
    assert.equal(grok.max_input_tokens, 1048576);
    assert.equal(typeof grok.max_tokens, "number");
    assert.equal(grok.capabilities.image_input.supported, true);
    assert.equal(grok.capabilities.pdf_input.supported, false);
    assert.equal(grok.capabilities.code_execution.supported, false);
    assert.equal(grok.capabilities.effort.supported, true);
    assert.deepEqual(grok.capabilities.effort, {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      max: { supported: false },
      xhigh: { supported: true },
    });
    assert.equal(grok.capabilities.thinking.supported, true);
    assert.deepEqual(grok.capabilities.thinking.types, {
      adaptive: { supported: true },
      enabled: { supported: true },
    });

    const gpt = body.data.find((entry) => entry.id === "gpt-5.6-sol");
    assert.equal(gpt.display_name, "GPT-5.6-Sol");
    assert.equal(gpt.max_input_tokens, 872000);
    assert.equal(gpt.capabilities.image_input.supported, true);
    assert.equal(gpt.capabilities.code_execution.supported, true);
    assert.equal(gpt.capabilities.effort.max.supported, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synthesized Anthropic entries carry client fields and do not guess context management", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  // grok-4.6 has supports_reasoning_summaries in the catalog, which used to be
  // misread as support for the three Anthropic context-management betas.
  config.providers[0].models = ["grok-4.6"];
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "grok-4.6", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    const entry = (await response.json()).data[0];
    // Claude Desktop Discovery requires `name` even though the API reference
    // for api.anthropic.com does not list it.
    assert.equal(entry.name, "grok-4.6");
    assert.equal(entry.display_name, "Grok 4.6");
    assert.deepEqual(entry.capabilities.context_management, {
      supported: false,
      clear_thinking_20251015: { supported: false },
      clear_tool_uses_20250919: { supported: false },
      compact_20260112: { supported: false },
    });
    // Capabilities the catalog does describe are still derived.
    assert.equal(entry.capabilities.effort.supported, true);
    assert.equal(entry.capabilities.image_input.supported, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a real Anthropic ModelInfo upstream is passed through unchanged", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.providers[0].models = ["claude-opus-5"];
  const client = config.api_keys[0];
  const upstreamEntry = {
    id: "claude-opus-5",
    type: "model",
    display_name: "Claude Opus 5",
    created_at: "2026-07-24T00:00:00Z",
    max_input_tokens: 200000,
    max_tokens: 64000,
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: true },
      context_management: {
        supported: true,
        clear_thinking_20251015: { supported: true },
        clear_tool_uses_20250919: { supported: true },
        compact_20260112: { supported: true },
      },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        max: { supported: true },
        xhigh: { supported: true },
      },
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: {
        supported: true,
        types: { adaptive: { supported: true }, enabled: { supported: true } },
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [upstreamEntry] });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    const entry = (await response.json()).data[0];
    // The upstream's own ModelInfo wins over anything derived from the catalog:
    // real created_at, real 64k output limit, real context management.
    assert.equal(entry.created_at, "2026-07-24T00:00:00Z");
    assert.equal(entry.max_tokens, 64000);
    assert.equal(entry.max_input_tokens, 200000);
    assert.equal(entry.capabilities.context_management.supported, true);
    assert.equal(entry.capabilities.code_execution.supported, true);
    // api.anthropic.com does not send `name`, so the gateway adds it for
    // Claude Desktop Discovery without disturbing the rest of the ModelInfo.
    assert.equal(entry.name, "claude-opus-5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic model entries fall back conservatively outside the catalog", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "model", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "x-api-key": "client",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const entry = body.data[0];
    assert.equal(entry.display_name, "model");
    assert.equal(entry.max_input_tokens, 200000);
    assert.equal(entry.max_tokens, 32000);
    assert.equal(entry.capabilities.image_input.supported, false);
    assert.equal(entry.capabilities.pdf_input.supported, false);
    assert.equal(entry.capabilities.code_execution.supported, false);
    assert.equal(entry.capabilities.effort.supported, false);
    assert.equal(entry.capabilities.thinking.supported, false);
    assert.equal(entry.capabilities.context_management.supported, false);
    // The 200k fallback is not a 1M context window.
    assert.equal(entry.supports1m, false);
    assert.equal(entry.prefer1m, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only models with a 1M context window advertise the 1M flags", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  // grok-4.6 has a 1M context window in the catalog; gpt-5.6-sol has 872k.
  config.providers[0].models = ["grok-4.6", "gpt-5.6-sol"];
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      data: [
        { id: "grok-4.6", object: "model" },
        { id: "gpt-5.6-sol", object: "model" },
      ],
    });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "x-api-key": "client",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    const body = await response.json();
    const grok = body.data.find((entry) => entry.id === "grok-4.6");
    const gpt = body.data.find((entry) => entry.id === "gpt-5.6-sol");
    assert.equal(grok.max_input_tokens, 1048576);
    assert.equal(grok.supports1m, true);
    assert.equal(grok.prefer1m, true);
    assert.equal(gpt.max_input_tokens, 872000);
    assert.equal(gpt.supports1m, false);
    assert.equal(gpt.prefer1m, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model format selection prefers the Anthropic protocol over user agents", () => {
  const anthropic = new Request("https://gateway.example/v1/models", {
    headers: { "anthropic-version": "2023-06-01", "user-agent": "codex/1.0" },
  });
  assert.equal(modelsFormatFor(anthropic), "anthropic");
  const codex = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "codex/1.0" },
  });
  assert.equal(modelsFormatFor(codex), "codex");
  const openai = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "OpenAI-SDK" },
  });
  assert.equal(modelsFormatFor(openai), "openai");
});

test("model format selection detects Claude user agents without protocol headers", () => {
  const claudeCli = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "claude-cli/1.0.0" },
  });
  assert.equal(modelsFormatFor(claudeCli), "anthropic");
  const claudeDesktop = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "claude-desktop" },
  });
  assert.equal(modelsFormatFor(claudeDesktop), "anthropic");
  const claudeCode = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "claude-code/2.0" },
  });
  assert.equal(modelsFormatFor(claudeCode), "anthropic");
});

test("model cache key hashing failures propagate", async (t) => {
  clearModelsCacheForTests();
  t.mock.method(crypto.subtle, "digest", async () => {
    throw new Error("SHA-256 unavailable");
  });
  const config = modelConfig();
  const { env } = healthEnvironment();

  await assert.rejects(
    handleModels(modelRequest(), env, config, config.api_keys[0]),
    /SHA-256 unavailable/,
  );
});

test("model catalogs reflect each client's per-key model routes", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.api_keys = [
    {
      id: "client-a",
      api_key: "client-a",
      providers: ["provider-0"],
      model_routes: {
        "per-key-alias": { model: "model" },
        "global-alias": { model: "model", providers: ["provider-0"] },
      },
    },
    {
      id: "client-b",
      api_key: "client-b",
      providers: ["provider-0"],
    },
  ];
  config.model_routes = {
    "global-alias": { model: "model" },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "model", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const first = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-a",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      config,
      config.api_keys[0],
      "first",
    );
    const second = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-b",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      config,
      config.api_keys[1],
      "second",
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(
      (await first.json()).data.map((model) => model.id),
      ["model", "global-alias", "per-key-alias"],
    );
    assert.deepEqual(
      (await second.json()).data.map((model) => model.id),
      ["model", "global-alias"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalogs reflect provider model routes over per-key and global routes", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.api_keys = [
    {
      id: "client-a",
      api_key: "client-a",
      providers: ["provider-0"],
      model_routes: {
        "per-key-alias": { model: "model" },
        "client-alias": { model: "model" },
      },
    },
  ];
  config.model_routes = {
    "global-alias": { model: "model" },
    "client-alias": { model: "model" },
  };
  config.providers[0].model_routes = {
    "provider-alias": { model: "model" },
    "client-alias": { model: "model" },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "model", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-a",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      config,
      config.api_keys[0],
      "test",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).data.map((model) => model.id),
      [
        "model",
        "global-alias",
        "client-alias",
        "per-key-alias",
        "provider-alias",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function modelConfig(providerCount = 1) {
  const providers = Array.from({ length: providerCount }, (_, index) => ({
    type: "ai_gateway",
    id: `provider-${index}`,
    base_url: `https://provider-${index}.example/v1`,
    credentials: [
      {
        id: `primary-key-${index}`,
        auth: { type: "api_key", api_key: `upstream-${index}` },
        disabled: false,
        priority: 100,
      },
      {
        id: `backup-key-${index}`,
        auth: { type: "api_key", api_key: `upstream-backup-${index}` },
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: providerCount - index,
    models: ["model"],
  }));
  return {
    providers,
    api_keys: [
      {
        id: "client",
        api_key: "client",
        providers: providers.map((provider) => provider.id),
      },
    ],
    model_routes: {
      "codex-auto-review": { model: "model", providers: [providers[0].id] },
    },
  };
}

function healthEnvironment() {
  const calls = { failure: 0, keyFailure: 0, success: 0 };
  const objects = new Map();
  const getByName = (name) => {
    if (!objects.has(name)) {
      const state = new ProviderHealthState();
      objects.set(name, {
        clear: async () => state.clear(),
        getStatus: async () => state.getStatus(),
        recordFailure: async () => {
          calls.failure += 1;
          return state.recordFailure();
        },
        recordImmediateFailure: async () => {
          calls.keyFailure += 1;
          return state.recordImmediateFailure();
        },
        recordSuccess: async () => {
          calls.success += 1;
          return state.recordSuccess();
        },
      });
    }
    return objects.get(name);
  };
  return {
    calls,
    env: {
      HEALTH: { getByName },
      MODELS_CACHE_TTL_SECONDS: "0",
    },
  };
}

function modelRequest() {
  return new Request("https://gateway.example/v1/models", {
    headers: { authorization: "Bearer client", "user-agent": "OpenAI-SDK" },
  });
}

test("model catalogs cancel unused error bodies and only 400/503 affect HTTP health", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
    assert.equal(calls.failure, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 503 model catalog responses increment catalog health", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 502);
    assert.equal(calls.failure, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const phase of ["headers", "body"]) {
  test(
    `client cancellation during catalog ${phase} does not count against health`,
    { timeout: 1000 },
    async (t) => {
      clearModelsCacheForTests();
      const config = modelConfig();
      const { env, calls } = healthEnvironment();
      const controller = new AbortController();
      const started = Promise.withResolvers();
      t.mock.method(globalThis, "fetch", async (request) => {
        const { signal } = request;
        if (phase === "headers") {
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            started.resolve(signal);
          });
        }
        return new Response(
          new ReadableStream({
            start(body) {
              signal.addEventListener(
                "abort",
                () => body.error(signal.reason),
                { once: true },
              );
              started.resolve(signal);
            },
          }),
        );
      });
      const response = handleModels(
        new Request(modelRequest(), { signal: controller.signal }),
        env,
        config,
        config.api_keys[0],
        "cancelled-catalog",
      );
      const signal = await started.promise;
      controller.abort();
      await response;
      assert.equal(signal.aborted, true);
      assert.deepEqual(calls, { failure: 0, keyFailure: 0, success: 0 });
    },
  );
}

test("HTTP 403 model catalog responses cool only the selected catalog key", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 403 });
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 502);
    assert.equal(calls.keyFailure, 1);
    assert.equal(calls.failure, 0);
    assert.equal(
      await credentialIsAvailable(
        env,
        "provider-0",
        "primary-key-0",
        "catalog",
      ),
      false,
    );
    assert.equal(
      await credentialIsAvailable(
        env,
        "provider-0",
        "primary-key-0",
        "inference",
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a catalog-cooled key is replaced only on the next catalog request", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  const authorizations = [];
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization"));
    attempts += 1;
    return attempts === 1
      ? new Response(null, { status: 403 })
      : Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const first = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "first",
    );
    clearModelsCacheForTests();
    const second = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "second",
    );
    assert.equal(first.status, 502);
    assert.equal(second.status, 200);
    assert.deepEqual(authorizations, [
      "Bearer upstream-0",
      "Bearer upstream-backup-0",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized model catalogs are cancelled before buffering", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 200,
        headers: { "content-length": String(MAX_MODEL_CATALOG_BODY_BYTES + 1) },
      },
    );
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
    assert.equal(calls.failure, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalogs honor key direct overrides and never bypass inherited proxies", async () => {
  const originalFetch = globalThis.fetch;
  let directCalls = 0;
  globalThis.fetch = async () => {
    directCalls += 1;
    return Response.json({ data: [{ id: "model" }] });
  };
  try {
    for (const override of [undefined, null]) {
      clearModelsCacheForTests();
      const config = modelConfig();
      config.providers[0].proxy = { url: "socks5://proxy.test:1080" };
      config.providers[0].credentials[0].proxy = override;
      const { env, calls } = healthEnvironment();
      const response = await handleModels(
        modelRequest(),
        env,
        config,
        config.api_keys[0],
        "proxy-selection",
      );
      assert.equal(response.status, override === null ? 200 : 502);
      assert.equal(calls.failure, override === null ? 0 : 1);
    }
    assert.equal(directCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog fan-out is bounded", async () => {
  clearModelsCacheForTests();
  const config = modelConfig(MODEL_CATALOG_CONCURRENCY * 2);
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    assert.equal(calls, MODEL_CATALOG_CONCURRENCY * 2);
    assert.equal(maximumActive, MODEL_CATALOG_CONCURRENCY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalogs use one selected key per provider", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.providers[0].credentials[0].disabled = true;
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  const authorizations = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization"));
    return Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(authorizations, ["Bearer upstream-backup-0"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalogs skip providers without an enabled key", async () => {
  clearModelsCacheForTests();
  const config = modelConfig(2);
  config.providers[0].credentials = config.providers[0].credentials.map(
    (key) => ({
      ...key,
      disabled: true,
    }),
  );
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    urls.push(request.url);
    return Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(urls, ["https://provider-1.example/v1/models"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
