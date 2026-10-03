import assert from "node:assert/strict";
import test from "node:test";
import {
  GLOBAL_SCOPE_KEY,
  parseScope,
  routesFor,
  scopeKey,
  scopeProviders,
} from "../console/src/features/routing/scope.ts";

const provider = (id, models, model_routes) => ({
  type: "ai_gateway",
  id,
  base_url: `https://${id}.example.com`,
  priority: 100,
  disabled: false,
  models,
  credentials: [
    {
      id: "primary",
      auth: { type: "api_key", api_key: "upstream-key" },
      priority: 100,
      disabled: false,
    },
  ],
  ...(model_routes ? { model_routes } : {}),
});
const config = () => ({
  providers: [
    provider("openai", ["gpt-5", "gpt-5-mini"], {
      fast: { model: "gpt-5-mini" },
    }),
    provider("anthropic", ["claude-sonnet-5"]),
  ],
  clients: [
    {
      id: "team",
      key: "sk-team",
      providers: ["anthropic"],
      model_routes: { best: { model: "claude-sonnet-5" } },
    },
  ],
  routes: { default: { model: "gpt-5" } },
});

test("scope keys round-trip without truncating provider or client IDs", () => {
  const scopes = [
    { kind: "global" },
    { kind: "provider", id: "openai" },
    { kind: "client", id: "team" },
  ];
  for (const scope of scopes)
    assert.deepEqual(parseScope(scopeKey(scope)), scope);
  assert.equal(scopeKey({ kind: "global" }), GLOBAL_SCOPE_KEY);
  assert.deepEqual(parseScope("unexpected"), { kind: "global" });
});

test("a provider scope reads that provider's routes and offers its own models", () => {
  const scope = parseScope(scopeKey({ kind: "provider", id: "openai" }));
  const current = config();
  assert.deepEqual(routesFor(current, scope), {
    fast: { model: "gpt-5-mini" },
  });
  assert.deepEqual(
    scopeProviders(current, scope).map((entry) => entry.id),
    ["openai"],
  );
  assert.deepEqual(
    scopeProviders(current, scope).flatMap((entry) => entry.models),
    ["gpt-5", "gpt-5-mini"],
  );
});

test("a client scope limits upstream candidates to the client's providers", () => {
  const scope = parseScope(scopeKey({ kind: "client", id: "team" }));
  const current = config();
  assert.deepEqual(routesFor(current, scope), {
    best: { model: "claude-sonnet-5" },
  });
  assert.deepEqual(
    scopeProviders(current, scope).map((entry) => entry.id),
    ["anthropic"],
  );
});

test("the global scope covers every provider and reads global routes", () => {
  const scope = parseScope(GLOBAL_SCOPE_KEY);
  const current = config();
  assert.deepEqual(routesFor(current, scope), { default: { model: "gpt-5" } });
  assert.deepEqual(
    scopeProviders(current, scope).map((entry) => entry.id),
    ["openai", "anthropic"],
  );
});

test("missing scope targets read as empty without mutating resources", () => {
  const current = config();
  const before = structuredClone(current);
  for (const scope of [
    { kind: "provider", id: "missing" },
    { kind: "client", id: "missing" },
  ]) {
    assert.deepEqual(routesFor(current, scope), {});
    assert.deepEqual(scopeProviders(current, scope), []);
  }
  assert.deepEqual(current, before);
});
