import assert from "node:assert/strict";
import test from "node:test";

import { resolveStoredAffinity } from "../src/gateway/routing/affinity.ts";
import { parseConfig } from "../src/config/store.ts";
import {
  FAILURE_THRESHOLD,
  ProviderHealthState,
} from "../src/gateway/health/health.ts";
import {
  allowedProviderCandidates,
  resolveModelRoute,
  selectAvailableCatalogTargetsWithDetails,
  selectAvailableProvider,
  selectAvailableProviderWithDetails,
  selectProviderCredential,
} from "../src/gateway/routing/routing.ts";

const config = parseConfig({
  providers: [
    {
      type: "ai_gateway",
      id: "secondary",
      base_url: "https://secondary.example/v1",
      credentials: [
        {
          id: "secondary-key",
          auth: { type: "api_key", api_key: "two" },
          disabled: false,
          priority: 10,
        },
      ],
      disabled: false,
      priority: 10,
      models: ["grok-4.5", "review-model"],
    },
    {
      type: "ai_gateway",
      id: "primary",
      base_url: "https://primary.example/v1",
      credentials: [
        {
          id: "primary-backup",
          auth: { type: "api_key", api_key: "one-backup" },
          disabled: false,
          priority: 10,
        },
        {
          id: "primary-key",
          auth: { type: "api_key", api_key: "one" },
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 100,
      models: ["grok-4.5", "review-model"],
    },
  ],
  api_keys: [
    { id: "client", api_key: "client", providers: ["secondary", "primary"] },
  ],
  model_routes: {
    "gpt-5.6-sol": { model: "grok-4.5" },
    "codex-auto-review": { model: "review-model", providers: ["secondary"] },
  },
});
const client = config.api_keys[0];

function routingEnvironment() {
  const healthObjects = new Map();
  const affinities = new Map();
  const healthObject = (name) => {
    if (!healthObjects.has(name)) {
      healthObjects.set(name, new ProviderHealthState());
    }
    return healthObjects.get(name);
  };
  return {
    affinities,
    healthObject,
    env: {
      HEALTH: { getByName: healthObject },
      SESSION_AFFINITY: {
        getByName: (name) => ({
          resolve: async (candidates, preferred) => {
            const stored = affinities.get(name);
            if (stored) {
              const decision = resolveStoredAffinity(
                stored,
                candidates,
                preferred,
              );
              if (!decision.selection) {
                affinities.delete(name);
                return undefined;
              }
              const next = {
                ...stored,
                ...decision.selection,
                updated_at: Date.now(),
              };
              affinities.set(name, next);
              return { ...next, status: decision.status };
            }
            if (!preferred) {
              affinities.delete(name);
              return undefined;
            }
            const next = { ...preferred, updated_at: Date.now() };
            affinities.set(name, next);
            return { ...next, status: "created" };
          },
        }),
      },
    },
  };
}

test("provider credentials are selected by priority", () => {
  assert.equal(selectProviderCredential(config.providers[1]).id, "primary-key");
});

test("disabled provider credentials are skipped", () => {
  const provider = {
    ...config.providers[1],
    credentials: config.providers[1].credentials.map((key) => ({
      ...key,
      disabled: key.id === "primary-key",
    })),
  };
  assert.equal(selectProviderCredential(provider).id, "primary-backup");
});

test("equal credential priorities follow configuration order", () => {
  const provider = {
    ...config.providers[1],
    credentials: config.providers[1].credentials.map((key) => ({
      ...key,
      priority: 50,
    })),
  };
  assert.equal(selectProviderCredential(provider).id, "primary-backup");
  assert.equal(
    selectProviderCredential({
      ...provider,
      credentials: provider.credentials.toReversed(),
    }).id,
    "primary-key",
  );
});

test("unconstrained routes resolve globally and providers remain priority ordered", () => {
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(
      ({ provider, credentials, upstreamModel, routeApplied }) => [
        provider.id,
        credentials.map((key) => key.id),
        upstreamModel,
        routeApplied,
      ],
    ),
    [
      ["primary", ["primary-backup", "primary-key"], "grok-4.5", true],
      ["secondary", ["secondary-key"], "grok-4.5", true],
    ],
  );
});

test("an unconfigured upstream model is not marked as a route", () => {
  const route = resolveModelRoute(config, client, "review-model");
  assert.deepEqual(
    route.targets.map(({ upstreamModel, routeApplied }) => [
      upstreamModel,
      routeApplied,
    ]),
    [
      ["review-model", false],
      ["review-model", false],
    ],
  );
});

test("route provider constraints override global provider priority", () => {
  const route = resolveModelRoute(config, client, "codex-auto-review");
  assert.deepEqual(
    route.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [["secondary", "review-model"]],
  );
});

test("route provider constraints are intersected with client provider access", () => {
  const route = resolveModelRoute(
    config,
    { id: "limited", api_key: "limited", providers: ["primary"] },
    "codex-auto-review",
  );
  assert.deepEqual(route.targets, []);
});

test("required capabilities filter providers before routing selection", () => {
  const capabilityConfig = parseConfig({
    providers: [
      {
        type: "ai_gateway",
        id: "unsupported",
        base_url: "https://unsupported.example/v1",
        credentials: [
          {
            id: "unsupported-key",
            auth: { type: "api_key", api_key: "unsupported" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 100,
        supports_websocket: false,
        supports_web_search: false,
        models: ["model"],
      },
      {
        type: "ai_gateway",
        id: "supported",
        base_url: "https://supported.example/v1",
        credentials: [
          {
            id: "supported-key",
            auth: { type: "api_key", api_key: "supported" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        supports_websocket: true,
        supports_web_search: true,
        models: ["model"],
      },
    ],
    api_keys: [
      {
        id: "client",
        api_key: "client",
        providers: ["unsupported", "supported"],
      },
    ],
    model_routes: {},
  });
  const capabilityClient = capabilityConfig.api_keys[0];

  assert.deepEqual(
    resolveModelRoute(capabilityConfig, capabilityClient, "model").targets.map(
      ({ provider }) => provider.id,
    ),
    ["unsupported", "supported"],
  );
  assert.deepEqual(
    resolveModelRoute(capabilityConfig, capabilityClient, "model", {
      requiredCapabilities: ["supports_web_search"],
    }).targets.map(({ provider }) => provider.id),
    ["supported"],
  );
  assert.deepEqual(
    resolveModelRoute(capabilityConfig, capabilityClient, "model", {
      requiredCapabilities: ["supports_websocket"],
    }).targets.map(({ provider }) => provider.id),
    ["supported"],
  );
});

test("a route can constrain a real upstream model name", () => {
  const route = resolveModelRoute(
    {
      ...config,
      model_routes: {
        ...config.model_routes,
        "grok-4.5": { model: "grok-4.5", providers: ["secondary"] },
      },
    },
    client,
    "grok-4.5",
  );
  assert.deepEqual(
    route.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [["secondary", "grok-4.5"]],
  );
});

test("per-key routes override global routes for the same model", () => {
  const route = resolveModelRoute(
    {
      ...config,
      api_keys: [
        {
          id: "client",
          api_key: "client",
          providers: ["primary", "secondary"],
          model_routes: {
            "gpt-5.6-sol": { model: "review-model", providers: ["secondary"] },
          },
        },
      ],
    },
    {
      id: "client",
      api_key: "client",
      providers: ["primary", "secondary"],
      model_routes: {
        "gpt-5.6-sol": { model: "review-model", providers: ["secondary"] },
      },
    },
    "gpt-5.6-sol",
  );
  assert.deepEqual(
    route.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [["secondary", "review-model"]],
  );
});

test("per-key routes leave unconfigured models on the global routes", () => {
  const keyClient = {
    id: "client",
    api_key: "client",
    providers: ["primary", "secondary"],
    model_routes: {
      "codex-auto-review": { model: "review-model", providers: ["primary"] },
    },
  };
  const routed = resolveModelRoute(config, keyClient, "gpt-5.6-sol");
  assert.deepEqual(
    routed.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [
      ["primary", "grok-4.5"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("per-key routes apply only to the configured client", () => {
  const otherClient = {
    id: "other",
    api_key: "other",
    providers: ["primary", "secondary"],
  };
  const routed = resolveModelRoute(config, otherClient, "gpt-5.6-sol");
  assert.deepEqual(
    routed.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [
      ["primary", "grok-4.5"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("per-key route providers are intersected with client provider access", () => {
  const keyClient = {
    id: "limited",
    api_key: "limited",
    providers: ["primary"],
    model_routes: {
      "gpt-5.6-sol": { model: "review-model", providers: ["secondary"] },
    },
  };
  const route = resolveModelRoute(config, keyClient, "gpt-5.6-sol");
  assert.deepEqual(route.targets, []);
});

test("provider routes override per-key and global routes per provider", () => {
  const providerRoutes = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      model_routes:
        provider.id === "primary"
          ? { "gpt-5.6-sol": { model: "review-model" } }
          : { "gpt-5.6-sol": { model: "grok-4.5" } },
    })),
  };
  const route = resolveModelRoute(providerRoutes, client, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [
      ["primary", "review-model"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("provider routes override lower layers even when the lower route constrains providers", () => {
  const providerRoutes = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      model_routes:
        provider.id === "primary"
          ? { "gpt-5.6-sol": { model: "review-model" } }
          : undefined,
    })),
  };
  const keyClient = {
    id: "client",
    api_key: "client",
    providers: ["primary", "secondary"],
    model_routes: {
      "gpt-5.6-sol": { model: "grok-4.5", providers: ["secondary"] },
    },
  };
  const route = resolveModelRoute(providerRoutes, keyClient, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [
      ["primary", "review-model"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("a provider route can hide a model from that provider only", () => {
  const route = resolveModelRoute(
    {
      ...config,
      providers: config.providers.map((provider) => ({
        ...provider,
        model_routes:
          provider.id === "primary"
            ? { "grok-4.5": { model: "review-model" } }
            : undefined,
      })),
    },
    client,
    "grok-4.5",
  );
  assert.deepEqual(
    route.targets.map(({ provider, upstreamModel }) => [
      provider.id,
      upstreamModel,
    ]),
    [
      ["primary", "review-model"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("disabled providers are excluded before priority and health selection", async () => {
  const disabledConfig = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      disabled: provider.id === "primary",
    })),
  };
  const route = resolveModelRoute(disabledConfig, client, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ provider }) => provider.id),
    ["secondary"],
  );

  let healthChecks = 0;
  const selected = await selectAvailableProvider(
    {
      HEALTH: {
        getByName: () => ({
          getStatus: async () => {
            healthChecks += 1;
            return { failures: 0, cooling_until: null };
          },
        }),
      },
    },
    route,
  );
  assert.equal(selected.id, "secondary");
  assert.equal(healthChecks, 2);
});

test("a disabled route-constrained provider is unavailable", () => {
  const disabledConfig = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      disabled: provider.id === "secondary",
    })),
  };
  const route = resolveModelRoute(disabledConfig, client, "codex-auto-review");
  assert.deepEqual(route.targets, []);
});

test("a provider without enabled credentials is excluded from routing", () => {
  const noPrimaryKeys = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      credentials:
        provider.id === "primary"
          ? provider.credentials.map((key) => ({ ...key, disabled: true }))
          : provider.credentials,
    })),
  };
  const route = resolveModelRoute(noPrimaryKeys, client, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ provider }) => provider.id),
    ["secondary"],
  );
});

test("a cooling primary provider is skipped for the next priority", async () => {
  const primary = new ProviderHealthState();
  const secondary = new ProviderHealthState();
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    primary.recordFailure();
  }
  const objects = new Map([
    ["primary", primary],
    ["secondary", secondary],
    ["key:primary:primary-backup", new ProviderHealthState()],
    ["key:primary:primary-key", new ProviderHealthState()],
    ["key:secondary:secondary-key", new ProviderHealthState()],
  ]);
  const env = {
    HEALTH: {
      getByName: (name) => objects.get(name),
    },
  };
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const selected = await selectAvailableProvider(env, route);
  assert.equal(selected.id, "secondary");
});

test("equal provider and credential priorities follow their configuration order", async () => {
  const equalConfig = parseConfig({
    providers: [
      {
        type: "ai_gateway",
        id: "first",
        base_url: "https://first.example/v1",
        credentials: [
          {
            id: "first-a",
            auth: { type: "api_key", api_key: "a" },
            disabled: false,
            priority: 10,
          },
          {
            id: "first-b",
            auth: { type: "api_key", api_key: "b" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
      {
        type: "ai_gateway",
        id: "second",
        base_url: "https://second.example/v1",
        credentials: [
          {
            id: "second-a",
            auth: { type: "api_key", api_key: "c" },
            disabled: false,
            priority: 10,
          },
          {
            id: "second-b",
            auth: { type: "api_key", api_key: "d" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client", providers: ["first", "second"] },
    ],
    model_routes: {},
  });
  const route = resolveModelRoute(
    equalConfig,
    equalConfig.api_keys[0],
    "model",
  );
  const { env } = routingEnvironment();

  const defaultSelection = await selectAvailableProviderWithDetails(env, route);
  assert.equal(defaultSelection.target.provider.id, "first");
  assert.equal(defaultSelection.target.credential.id, "first-a");

  const reversedProviders = {
    ...equalConfig,
    providers: equalConfig.providers.toReversed(),
  };
  const selection = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(reversedProviders, equalConfig.api_keys[0], "model"),
  );
  assert.equal(selection.target.provider.id, "second");
  assert.equal(selection.target.credential.id, "second-a");

  const reversedCredentials = {
    ...equalConfig,
    providers: equalConfig.providers.map((provider) => ({
      ...provider,
      credentials: provider.credentials.toReversed(),
    })),
  };
  const secondSelection = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(reversedCredentials, equalConfig.api_keys[0], "model"),
  );
  assert.equal(secondSelection.target.provider.id, "first");
  assert.equal(secondSelection.target.credential.id, "first-b");
});

test("a cooling key is skipped without cooling its provider", async () => {
  const { env, healthObject } = routingEnvironment();
  healthObject("key:primary:primary-key").recordImmediateFailure();
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const selection = await selectAvailableProviderWithDetails(env, route);

  assert.equal(selection.target.provider.id, "primary");
  assert.equal(selection.target.credential.id, "primary-backup");
  assert.equal(
    selection.credentialChecks.find(
      (check) => check.credential_id === "primary-key",
    ).available,
    false,
  );
});

test("a provider with no available credentials falls back to the next provider priority", async () => {
  const { env, healthObject } = routingEnvironment();
  healthObject("key:primary:primary-key").recordImmediateFailure();
  healthObject("key:primary:primary-backup").recordImmediateFailure();
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const selection = await selectAvailableProviderWithDetails(env, route);

  assert.equal(selection.target.provider.id, "secondary");
  assert.equal(selection.target.credential.id, "secondary-key");
});

test("catalog selection uses catalog health and credential configuration order", async () => {
  const catalogConfig = parseConfig({
    providers: [
      {
        type: "ai_gateway",
        id: "catalog",
        base_url: "https://catalog.example/v1",
        credentials: [
          {
            id: "catalog-a",
            auth: { type: "api_key", api_key: "a" },
            disabled: false,
            priority: 10,
          },
          {
            id: "catalog-b",
            auth: { type: "api_key", api_key: "b" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 10,
        models: ["model"],
      },
    ],
    api_keys: [{ id: "client", api_key: "client", providers: ["catalog"] }],
    model_routes: {},
  });
  const { env, healthObject } = routingEnvironment();
  healthObject("key:catalog:catalog-a").recordImmediateFailure();
  const candidates = allowedProviderCandidates(
    catalogConfig,
    catalogConfig.api_keys[0],
  );

  const first = await selectAvailableCatalogTargetsWithDetails(env, candidates);
  assert.equal(first.targets[0].credential.id, "catalog-a");

  healthObject("key:catalog:catalog-a:catalog").recordImmediateFailure();
  const second = await selectAvailableCatalogTargetsWithDetails(
    env,
    candidates,
  );
  assert.equal(second.targets[0].credential.id, "catalog-b");
});

test("session affinity is stable, client-isolated, and rebinds after key cooldown", async () => {
  const equalConfig = parseConfig({
    providers: [
      {
        type: "ai_gateway",
        id: "first",
        base_url: "https://first.example/v1",
        credentials: [
          {
            id: "first-a",
            auth: { type: "api_key", api_key: "a" },
            disabled: false,
            priority: 10,
          },
          {
            id: "first-b",
            auth: { type: "api_key", api_key: "b" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
      {
        type: "ai_gateway",
        id: "second",
        base_url: "https://second.example/v1",
        credentials: [
          {
            id: "second-a",
            auth: { type: "api_key", api_key: "c" },
            disabled: false,
            priority: 10,
          },
          {
            id: "second-b",
            auth: { type: "api_key", api_key: "d" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client-a", api_key: "client-a", providers: ["first", "second"] },
    ],
    model_routes: {},
  });
  const route = resolveModelRoute(
    equalConfig,
    equalConfig.api_keys[0],
    "model",
  );
  const { env, healthObject } = routingEnvironment();
  const initialConfig = {
    ...equalConfig,
    providers: equalConfig.providers.toReversed().map((provider) => ({
      ...provider,
      credentials: provider.credentials.toReversed(),
    })),
  };
  const first = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(initialConfig, equalConfig.api_keys[0], "model"),
    { session: { clientId: "client-a", sessionId: "session" } },
  );
  assert.deepEqual(
    [
      first.target.provider.id,
      first.target.credential.id,
      first.affinity.status,
    ],
    ["second", "second-b", "created"],
  );

  const repeated = await selectAvailableProviderWithDetails(env, route, {
    session: { clientId: "client-a", sessionId: "session" },
  });
  assert.deepEqual(
    [
      repeated.target.provider.id,
      repeated.target.credential.id,
      repeated.affinity.status,
    ],
    ["second", "second-b", "hit"],
  );

  const otherClient = await selectAvailableProviderWithDetails(env, route, {
    session: { clientId: "client-b", sessionId: "session" },
  });
  assert.deepEqual(
    [otherClient.target.provider.id, otherClient.target.credential.id],
    ["first", "first-a"],
  );

  healthObject("key:second:second-b").recordImmediateFailure();
  const rebound = await selectAvailableProviderWithDetails(env, route, {
    session: { clientId: "client-a", sessionId: "session" },
  });
  assert.deepEqual(
    [
      rebound.target.provider.id,
      rebound.target.credential.id,
      rebound.affinity.status,
    ],
    ["first", "first-a", "rebound"],
  );
});

test("session affinity upgrades when a higher-priority provider recovers", async () => {
  const { env, healthObject } = routingEnvironment();
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    healthObject("primary").recordFailure();
  }
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const session = { clientId: "client", sessionId: "provider-upgrade" };
  const initial = await selectAvailableProviderWithDetails(env, route, {
    session,
  });
  assert.deepEqual(
    [initial.target.provider.id, initial.affinity.status],
    ["secondary", "created"],
  );

  healthObject("primary").clear();
  const upgraded = await selectAvailableProviderWithDetails(env, route, {
    session,
  });
  assert.deepEqual(
    [
      upgraded.target.provider.id,
      upgraded.target.credential.id,
      upgraded.affinity.status,
    ],
    ["primary", "primary-key", "rebound"],
  );
});

test("session affinity upgrades a key only inside its current top-priority provider", async () => {
  const { env, healthObject } = routingEnvironment();
  healthObject("key:primary:primary-key").recordImmediateFailure();
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const session = { clientId: "client", sessionId: "key-upgrade" };
  const initial = await selectAvailableProviderWithDetails(env, route, {
    session,
  });
  assert.deepEqual(
    [
      initial.target.provider.id,
      initial.target.credential.id,
      initial.affinity.status,
    ],
    ["primary", "primary-backup", "created"],
  );

  healthObject("key:primary:primary-key").clear();
  const upgraded = await selectAvailableProviderWithDetails(env, route, {
    session,
  });
  assert.deepEqual(
    [
      upgraded.target.provider.id,
      upgraded.target.credential.id,
      upgraded.affinity.status,
    ],
    ["primary", "primary-key", "rebound"],
  );
});

test("equal provider and key priorities do not churn an existing affinity", async () => {
  const equalConfig = parseConfig({
    providers: [
      {
        type: "ai_gateway",
        id: "first",
        base_url: "https://first.example/v1",
        credentials: [
          {
            id: "first-key",
            auth: { type: "api_key", api_key: "first" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
      {
        type: "ai_gateway",
        id: "second",
        base_url: "https://second.example/v1",
        credentials: [
          {
            id: "second-key",
            auth: { type: "api_key", api_key: "second" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client", providers: ["first", "second"] },
    ],
    model_routes: {},
  });
  const { env } = routingEnvironment();
  const route = resolveModelRoute(
    equalConfig,
    equalConfig.api_keys[0],
    "model",
  );
  const session = { clientId: "client", sessionId: "equal-priority" };
  const initialConfig = {
    ...equalConfig,
    providers: equalConfig.providers.toReversed(),
  };
  const initial = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(initialConfig, equalConfig.api_keys[0], "model"),
    { session },
  );
  assert.equal(initial.target.provider.id, "second");

  const repeated = await selectAvailableProviderWithDetails(env, route, {
    session,
  });
  assert.deepEqual(
    [repeated.target.provider.id, repeated.affinity.status],
    ["second", "hit"],
  );
});

test("session affinity rebinds after a required provider capability is removed", async () => {
  const capabilityConfig = parseConfig({
    providers: [
      {
        type: "ai_gateway",
        id: "first",
        base_url: "https://first.example/v1",
        credentials: [
          {
            id: "first-key",
            auth: { type: "api_key", api_key: "first" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        supports_websocket: false,
        supports_web_search: true,
        models: ["model"],
      },
      {
        type: "ai_gateway",
        id: "second",
        base_url: "https://second.example/v1",
        credentials: [
          {
            id: "second-key",
            auth: { type: "api_key", api_key: "second" },
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        supports_websocket: false,
        supports_web_search: true,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client", providers: ["first", "second"] },
    ],
    model_routes: {},
  });
  const { env } = routingEnvironment();
  const session = { clientId: "client", sessionId: "capability-change" };
  const initial = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(capabilityConfig, capabilityConfig.api_keys[0], "model", {
      requiredCapabilities: ["supports_web_search"],
    }),
    { session },
  );
  assert.deepEqual(
    [initial.target.provider.id, initial.affinity.status],
    ["first", "created"],
  );

  const updatedConfig = {
    ...capabilityConfig,
    providers: capabilityConfig.providers.map((provider) =>
      provider.id === "first"
        ? { ...provider, supports_web_search: false }
        : provider,
    ),
  };
  const rebound = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(updatedConfig, capabilityConfig.api_keys[0], "model", {
      requiredCapabilities: ["supports_web_search"],
    }),
    { session },
  );
  assert.deepEqual(
    [rebound.target.provider.id, rebound.affinity.status],
    ["second", "rebound"],
  );
});

test("session affinity rebinds for every configuration, permission, model, and provider invalidation", async () => {
  const { env, healthObject } = routingEnvironment();
  const initialRoute = resolveModelRoute(config, client, "gpt-5.6-sol");
  const initial = await selectAvailableProviderWithDetails(env, initialRoute, {
    session: { clientId: "client", sessionId: "reconfigure" },
  });
  assert.equal(initial.target.provider.id, "primary");

  const disabledConfig = {
    ...config,
    providers: config.providers.map((provider) =>
      provider.id === "primary" ? { ...provider, disabled: true } : provider,
    ),
  };
  const rebound = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(disabledConfig, client, "gpt-5.6-sol"),
    {
      session: { clientId: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [rebound.target.provider.id, rebound.affinity.status],
    ["secondary", "rebound"],
  );

  const permissionRoute = resolveModelRoute(
    config,
    { id: "client", api_key: "client", providers: ["primary"] },
    "gpt-5.6-sol",
  );
  const permissionSelection = await selectAvailableProviderWithDetails(
    env,
    permissionRoute,
    {
      session: { clientId: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [
      permissionSelection.target.provider.id,
      permissionSelection.affinity.status,
    ],
    ["primary", "rebound"],
  );

  const removedConfig = {
    ...config,
    providers: config.providers.filter((provider) => provider.id !== "primary"),
  };
  const removedSelection = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(removedConfig, client, "gpt-5.6-sol"),
    {
      session: { clientId: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [removedSelection.target.provider.id, removedSelection.affinity.status],
    ["secondary", "rebound"],
  );

  const unsupportedConfig = {
    ...config,
    providers: config.providers.map((provider) =>
      provider.id === "secondary"
        ? { ...provider, models: ["other-model"] }
        : provider,
    ),
  };
  const unsupportedSelection = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(unsupportedConfig, client, "gpt-5.6-sol"),
    {
      session: { clientId: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [
      unsupportedSelection.target.provider.id,
      unsupportedSelection.affinity.status,
    ],
    ["primary", "rebound"],
  );

  const disabledKeyConfig = {
    ...config,
    providers: config.providers.map((provider) =>
      provider.id === "primary"
        ? {
            ...provider,
            credentials: provider.credentials.map((key) =>
              key.id === "primary-key" ? { ...key, disabled: true } : key,
            ),
          }
        : provider,
    ),
  };
  const disabledCredentialSelection = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(disabledKeyConfig, client, "gpt-5.6-sol"),
    {
      session: { clientId: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [
      disabledCredentialSelection.target.provider.id,
      disabledCredentialSelection.target.credential.id,
      disabledCredentialSelection.affinity.status,
    ],
    ["primary", "primary-backup", "rebound"],
  );

  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    healthObject("primary").recordFailure();
  }
  const coolingSelection = await selectAvailableProviderWithDetails(
    env,
    resolveModelRoute(config, client, "gpt-5.6-sol"),
    {
      session: { clientId: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [coolingSelection.target.provider.id, coolingSelection.affinity.status],
    ["secondary", "rebound"],
  );
});

test("affinity read failures prevent session requests from changing targets", async () => {
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const { env } = routingEnvironment();
  env.SESSION_AFFINITY.getByName = () => {
    throw new Error("affinity unavailable");
  };
  const selection = await selectAvailableProviderWithDetails(env, route, {
    session: { clientId: "client", sessionId: "session" },
  });

  assert.equal(selection.target, undefined);
  assert.equal(selection.affinity.status, "failed");
});

test("a model route requires the real upstream model in the provider list", () => {
  assert.throws(() =>
    parseConfig({
      providers: [
        {
          type: "ai_gateway",
          id: "alias-only",
          base_url: "https://alias.example/v1",
          credentials: [
            {
              id: "alias-key",
              auth: { type: "api_key", api_key: "alias-key" },
              disabled: false,
              priority: 1,
            },
          ],
          disabled: false,
          priority: 1,
          models: ["gpt-5.6-sol", "review-model"],
        },
      ],
      api_keys: [
        {
          id: "alias-client",
          api_key: "alias-client",
          providers: ["alias-only"],
        },
      ],
      model_routes: {
        "gpt-5.6-sol": { model: "grok-4.5" },
        "codex-auto-review": {
          model: "review-model",
          providers: ["alias-only"],
        },
      },
    }),
  );
});
