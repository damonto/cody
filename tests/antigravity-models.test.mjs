import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config/store.ts";
import {
  antigravityModelGroups,
  providerModelNames,
} from "../src/shared/antigravity-models.ts";
import { resolveAntigravityModel } from "../src/providers/antigravity/reasoning.ts";
import { translateRequest } from "../src/providers/antigravity/request.ts";
import { antigravityAdapter } from "../src/providers/antigravity/index.ts";
import { openPart, sealPart } from "../src/providers/antigravity/replay.ts";
import {
  aggregateStandardModels,
  aggregateCodexModels,
} from "../src/gateway/catalog/models.ts";
import modelCatalog from "../src/gateway/catalog/models.json" with { type: "json" };
import {
  resolveModelRoute,
  modelIsAvailableForClient,
} from "../src/gateway/routing/routing.ts";

const family = "gemini-3.8-flash";
const familyTemplate = modelCatalog.models.find(
  (model) => model.slug === family,
);
const models = ["low", "medium", "high"].map((level) => `${family}-${level}`);
const ref = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
function config(selected = models) {
  return parseConfig({
    providers: [
      {
        type: "antigravity",
        id: "antigravity",
        models: selected,
        priority: 100,
        disabled: false,
        credentials: [
          {
            id: "account",
            priority: 100,
            disabled: false,
            auth: { type: "oauth", account_ref: ref },
          },
        ],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client-key", providers: ["antigravity"] },
    ],
  });
}
const scope = {
  client_id: "client",
  provider_id: "antigravity",
  account_ref: ref,
  model: models[2],
};

test("family grouping preserves physical IDs, real bare models and non-thinking suffixes", () => {
  assert.deepEqual(
    [
      ...antigravityModelGroups([
        ...models,
        "gemini-3.8-flash-tiered",
        "claude-opus-thinking",
      ]),
    ],
    [
      [family, models],
      ["gemini-3.8-flash-tiered", ["gemini-3.8-flash-tiered"]],
      ["claude-opus-thinking", ["claude-opus-thinking"]],
    ],
  );
  assert.equal(antigravityModelGroups([family, ...models]).size, 4);
  assert.equal(
    resolveAntigravityModel([family, ...models], family, {
      reasoning: { effort: "low" },
    }),
    family,
  );
  assert.deepEqual(providerModelNames({ type: "ai_gateway", models }), models);
});

for (const [payload, level] of [
  [{}, "high"],
  [{ reasoning: { effort: "auto" } }, "high"],
  [{ thinking: { type: "adaptive" } }, "high"],
  ...["low", "medium", "high"].flatMap((level) => [
    [{ reasoning: { effort: level } }, level],
    [
      { output_config: { effort: level }, thinking: { type: "adaptive" } },
      level,
    ],
  ]),
  [{ reasoning: { effort: "minimal" } }, "low"],
  [{ reasoning: { effort: "xhigh" } }, "high"],
  [{ reasoning: { effort: "max" } }, "high"],
  [{ reasoning: { effort: "none" } }, "low"],
  [{ thinking: { type: "disabled" }, reasoning: { effort: "high" } }, "low"],
  ...[
    [0, "low"],
    [1024, "low"],
    [1025, "medium"],
    [8192, "medium"],
    [8193, "high"],
  ].map(([budget, level]) => [
    { thinking: { type: "enabled", budget_tokens: budget } },
    level,
  ]),
  [
    {
      thinking: { type: "enabled", budget_tokens: 1024 },
      reasoning: { effort: "high" },
    },
    "low",
  ],
]) {
  test(`family selection ${JSON.stringify(payload)} -> ${level}`, () => {
    assert.equal(
      resolveAntigravityModel(models, family, payload),
      `${family}-${level}`,
    );
  });
}

test("missing explicit or default levels require configuration", () => {
  assert.throws(
    () => resolveAntigravityModel([models[0]], family),
    /high thinking level enabled/,
  );
  assert.throws(
    () => resolveAntigravityModel([models[1], models[0]], family),
    /high thinking level enabled/,
  );
  assert.throws(
    () =>
      resolveAntigravityModel([models[2]], family, {
        reasoning: { effort: "low" },
      }),
    /low thinking level enabled/,
  );
  for (const payload of [
    { reasoning: { effort: {} } },
    { reasoning: { effort: "ultra" } },
    { thinking: { budget_tokens: -1 } },
    { thinking: { budget_tokens: 1.5 } },
  ])
    assert.throws(() => resolveAntigravityModel(models, family, payload));
  assert.equal(
    resolveAntigravityModel(models, models[2], {
      reasoning: { effort: "low" },
    }),
    models[2],
  );
});

test("all route scopes accept configured families and preserve explicit override priority", () => {
  const value = config();
  value.model_routes = { alias: { model: family, providers: ["antigravity"] } };
  value.api_keys[0].model_routes = { alias: { model: models[0] } };
  value.providers[0].model_routes = { alias: { model: family } };
  const saved = parseConfig(value);
  const route = resolveModelRoute(saved, saved.api_keys[0], "alias", {
    payload: { reasoning: { effort: "medium" } },
  });
  assert.equal(route.targets[0].upstreamModel, models[1]);
  delete saved.providers[0].model_routes;
  assert.equal(
    resolveModelRoute(saved, saved.api_keys[0], "alias", {
      payload: { reasoning: { effort: "high" } },
    }).targets[0].upstreamModel,
    models[0],
  );
  saved.providers[0].models = ["other"];
  assert.throws(() => parseConfig(saved), /no provider supports|not listed/);
  const highOnly = config([models[2]]);
  const missing = resolveModelRoute(highOnly, highOnly.api_keys[0], family, {
    payload: { reasoning: { effort: "low" } },
  });
  assert.equal(missing.targets.length, 0);
  assert.equal(missing.resolutionError.code, "unsupported_reasoning_effort");
});

function catalog(value = config(), ids = models) {
  return [
    {
      provider: value.providers[0],
      success: true,
      models: ids.map((id, index) => ({
        id,
        raw: {
          id,
          owned_by: "antigravity",
          supports_thinking: true,
          context_window: 1000000 - index,
          max_output_tokens: 64000,
          input_modalities: index === 1 ? ["text"] : ["text", "image"],
        },
      })),
    },
  ];
}

test("catalogs group native variants but keep explicit aliases and other providers", () => {
  const value = config();
  const routes = new Map([
    ["antigravity", { alias: { model: family }, fixed: { model: models[2] } }],
  ]);
  const results = catalog(value);
  results.push({
    provider: { id: "other", type: "ai_gateway", models: [models[0]] },
    success: true,
    models: [{ id: models[0], raw: { id: models[0], owned_by: "other" } }],
  });
  const listed = aggregateStandardModels(results, routes);
  assert.deepEqual(
    listed.map((model) => model.id),
    ["fixed", family, "alias", models[0]],
  );
  const grouped = listed.find((model) => model.id === family);
  assert.equal(grouped.context_window, 999998);
  assert.deepEqual(grouped.input_modalities, ["text"]);
  assert.deepEqual(grouped.thinking_levels, ["low", "medium", "high"]);
  const codex = aggregateCodexModels(new Set([family]), new Set(), [
    { id: family, upstream: { id: family, raw: grouped } },
  ]);
  assert.equal(codex[0].default_reasoning_level, "high");
  assert.deepEqual(
    codex[0].supported_reasoning_levels.map((entry) => entry.effort),
    ["low", "medium", "high"],
  );
  const highOnly = aggregateStandardModels(
    catalog(config([models[2]])),
    new Map(),
  );
  assert.equal(highOnly.length, 1);
  assert.deepEqual(highOnly[0].thinking_levels, ["high"]);
});

test("Codex native families retain static client metadata and account capabilities", () => {
  const [grouped] = aggregateStandardModels(
    catalog(config([models[1], models[2]])),
    new Map(),
  );
  const [model] = aggregateCodexModels(new Set([family]), new Set(), [
    { id: family, upstream: { id: family, raw: grouped } },
  ]);
  assert.equal(model.display_name, "Gemini 3.8 Flash");
  assert.ok(familyTemplate.base_instructions.length > 0);
  assert.equal(model.base_instructions, familyTemplate.base_instructions);
  assert.deepEqual(model.model_messages, familyTemplate.model_messages);
  assert.equal(model.multi_agent_version, familyTemplate.multi_agent_version);
  assert.deepEqual(model.truncation_policy, { mode: "tokens", limit: 10000 });
  assert.equal(model.context_window, 999998);
  assert.equal(model.max_context_window, 999998);
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.equal(model.default_reasoning_level, "high");
  assert.deepEqual(
    model.supported_reasoning_levels,
    familyTemplate.supported_reasoning_levels.filter(
      ({ effort }) => effort !== "low",
    ),
  );
  assert.equal(model.support_verbosity, false);
  assert.equal(model.supports_experimental_context, false);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.node_repl_disabled, true);
  assert.equal(model.prefer_websockets, false);
});

test("Codex native aliases match their real model or thinking family", () => {
  const [grouped] = aggregateStandardModels(catalog(), new Map());
  const native = [
    { id: "alias", upstream: { id: family, raw: grouped } },
    { id: "gpt-6-astra", upstream: catalog()[0].models[2] },
  ];
  const listed = aggregateCodexModels(
    new Set(native.map(({ id }) => id)),
    new Set(["gpt-6-astra"]),
    native,
  );
  assert.deepEqual(
    listed.map(({ slug }) => slug),
    ["alias", "gpt-6-astra"],
  );
  for (const model of listed) {
    assert.equal(model.display_name, "Gemini 3.8 Flash");
    assert.equal(model.base_instructions, familyTemplate.base_instructions);
    assert.deepEqual(model.model_messages, familyTemplate.model_messages);
    assert.equal(model.supports_experimental_context, false);
    assert.equal(model.supports_search_tool, false);
    assert.equal(model.node_repl_disabled, true);
  }
  assert.equal(listed[1].context_window, 999998);
  assert.deepEqual(listed[1].input_modalities, ["text", "image"]);
});

test("native catalog matching does not use client names or unrelated suffixes", () => {
  for (const id of [
    `${family}-tiered`,
    `${family}-preview`,
    `${family}-high-low`,
    "unknown-native-model",
  ]) {
    const [model] = aggregateCodexModels(new Set([family]), new Set(), [
      {
        id: family,
        upstream: { id, raw: { display_name: id, context_window: 200000 } },
      },
    ]);
    assert.equal(model.slug, family);
    assert.equal(model.display_name, id);
    assert.equal(model.base_instructions, "");
    assert.equal(model.model_messages, undefined);
    assert.equal(model.context_window, 200000);
    assert.deepEqual(model.supported_reasoning_levels, []);
  }
});

test("native templates retain instructions without inheriting endpoint settings", () => {
  const sourceId = "gpt-6-astra";
  const template = modelCatalog.models.find((model) => model.slug === sourceId);
  const [model] = aggregateCodexModels(new Set(["native"]), new Set(), [
    { id: "native", upstream: { id: sourceId, raw: {} } },
  ]);
  const { instructions_template, instructions_variables, approvals } =
    template.model_messages;
  assert.deepEqual(model.model_messages, {
    instructions_template,
    instructions_variables,
    approvals,
  });
  assert.equal(model.supports_experimental_context, false);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.node_repl_disabled, true);
  assert.equal(model.prefer_websockets, false);
  assert.equal(model.context_window, null);
  assert.equal(Object.hasOwn(model, "service_tiers"), false);
  assert.equal(Object.hasOwn(model, "web_search_tool_type"), false);
  assert.ok(Object.hasOwn(template, "service_tiers"));
  assert.ok(Object.hasOwn(template.model_messages, "token_budget"));
});

for (const endpoint of ["responses", "messages", "messages/count_tokens"]) {
  for (const effort of ["low", "medium", "high"]) {
    test(`${endpoint} routes ${effort} and translates the same thinking level`, async () => {
      const value = config();
      const payload =
        endpoint === "responses"
          ? { model: family, input: "hi", reasoning: { effort } }
          : {
              model: family,
              messages: [{ role: "user", content: "hi" }],
              thinking: { type: "adaptive" },
              output_config: { effort },
            };
      const route = resolveModelRoute(value, value.api_keys[0], family, {
        endpoint,
        payload,
      });
      const prepared = await antigravityAdapter.prepare(
        value.providers[0],
        { token: "token", project_id: "project", account_ref: ref },
        {
          endpoint,
          payload,
          model: route.targets[0].upstreamModel,
          clientId: "client",
          request: new Request(`https://gateway.test/v1/${endpoint}`),
        },
        { env: { CONFIG_ENCRYPTION_KEY: key } },
      );
      const body = JSON.parse(prepared.body);
      assert.deepEqual(prepared.inferenceMetadata, {
        model: `${family}-${effort}`,
        reasoning: { effort },
      });
      assert.equal(
        body.request.generationConfig.thinkingConfig.thinkingLevel,
        effort,
      );
      if (endpoint !== "messages/count_tokens") {
        assert.equal(body.model, `${family}-${effort}`);
        const response = await prepared.transformResponse(
          Response.json({
            response: {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "hello" }] },
                  finishReason: "STOP",
                },
              ],
            },
          }),
        );
        assert.equal((await response.json()).model, family);
      }
    });
  }
}

test("explicit budgets govern both variant selection and native generation", async () => {
  const payload = {
    input: "hi",
    thinking: { budget_tokens: 1024 },
    reasoning: { effort: "high" },
  };
  const selected = resolveAntigravityModel(models, family, payload);
  const translated = await translateRequest(
    payload,
    "responses",
    { ...scope, model: selected },
    key,
  );
  assert.equal(selected, models[0]);
  assert.equal(
    translated.request.generationConfig.thinkingConfig.thinkingBudget,
    1024,
  );
});

test("family routing does not loosen signed history's physical-model boundary", async () => {
  const envelope = await sealPart(
    { text: "reasoning", thought: true, thoughtSignature: "native" },
    "self",
    scope,
    key,
  );
  await openPart(envelope, scope, key);
  await assert.rejects(
    openPart(envelope, { ...scope, model: models[0] }, key),
    /does not belong/,
  );
  await assert.rejects(
    openPart(envelope, { ...scope, model: family }, key),
    /does not belong/,
  );
});

test("Gemini enabled thinking without a budget keeps dynamic high selection", async () => {
  const payload = { input: "hi", thinking: { type: "enabled" } };
  const selected = resolveAntigravityModel(models, family, payload);
  const translated = await translateRequest(
    payload,
    "responses",
    { ...scope, model: selected },
    key,
  );
  assert.equal(selected, models[2]);
  assert.equal(
    translated.request.generationConfig.thinkingConfig.thinkingBudget,
    -1,
  );
});

test("configured family availability is independent of the default inference effort", () => {
  const value = config([models[0]]);
  assert.equal(
    modelIsAvailableForClient(value, value.api_keys[0], family),
    true,
  );
  assert.equal(
    resolveModelRoute(value, value.api_keys[0], family).resolutionError.code,
    "unsupported_reasoning_effort",
  );
  value.providers[0].credentials[0].disabled = true;
  assert.equal(
    modelIsAvailableForClient(value, value.api_keys[0], family),
    false,
  );
  assert.equal(
    resolveModelRoute(value, value.api_keys[0], family).resolutionError,
    undefined,
  );
});

test("family catalogs have deterministic levels and conservative incomplete metadata", () => {
  const value = config([models[2], models[0], models[1]]);
  const complete = aggregateStandardModels(catalog(value), new Map())[0];
  assert.deepEqual(complete.thinking_levels, ["low", "medium", "high"]);
  const partial = aggregateStandardModels(
    catalog(value, [models[2]]),
    new Map(),
  )[0];
  assert.deepEqual(partial.thinking_levels, ["high"]);
  assert.equal(partial.context_window, null);
  assert.equal(partial.max_output_tokens, null);
  assert.deepEqual(partial.input_modalities, []);
  assert.equal(partial.supports_thinking, false);
  const [codex] = aggregateCodexModels(new Set([family]), new Set(), [
    { id: family, upstream: { id: family, raw: partial } },
  ]);
  assert.equal(codex.base_instructions, familyTemplate.base_instructions);
  assert.equal(codex.context_window, null);
  assert.equal(codex.max_context_window, null);
  assert.deepEqual(codex.input_modalities, []);
  assert.equal(codex.supports_reasoning_summaries, false);
  assert.deepEqual(
    codex.supported_reasoning_levels.map(({ effort }) => effort),
    ["high"],
  );
});

test("invalid thinking modes and empty effort fail validation before variant selection", () => {
  for (const payload of [
    { thinking: [] },
    { reasoning: "high" },
    { output_config: false },
    { thinking: { type: {} } },
    { thinking: { type: "unknown" } },
    { reasoning: { effort: "" } },
  ])
    assert.throws(() => resolveAntigravityModel(models, family, payload));
});

test("compound suffixes remain explicit models instead of creating an empty family", () => {
  const model = `${family}-high-low`;
  assert.deepEqual([...antigravityModelGroups([model])], [[model, [model]]]);
});
