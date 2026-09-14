import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER_FAN_OUT_CONCURRENCY } from "../src/shared/concurrency.ts";
import {
  COOLDOWN_MS,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  clearCredentialHealth,
  clearProviderHealth,
  healthFailureScope,
  credentialIsAvailable,
  listCoolingHealth,
  listCoolingProviders,
  recordCredentialFailure,
  recordProviderFailure,
  scheduleHealthUpdate,
  providerIsAvailable,
  ProviderHealthState,
} from "../src/gateway/health/health.ts";

test("ten consecutive failures start a cooldown and success resets state", async () => {
  const health = new ProviderHealthState();
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    health.recordFailure();
  }

  let snapshot = health.getStatus();
  assert.equal(snapshot.failures, FAILURE_THRESHOLD);
  assert.equal(typeof snapshot.cooling_until, "number");

  snapshot = health.recordSuccess();
  assert.deepEqual(snapshot, { failures: 0, cooling_until: null });
});

test("failures outside the five-minute window do not join the same streak", async () => {
  let now = 1_000;
  const health = new ProviderHealthState(() => now);

  for (let index = 0; index < FAILURE_THRESHOLD - 1; index += 1) {
    health.recordFailure();
  }

  now += FAILURE_WINDOW_MS;
  health.recordFailure();

  const snapshot = health.getStatus();
  assert.deepEqual(snapshot, { failures: 1, cooling_until: null });
});

test("an expired failure window is cleared when health is read", async () => {
  let now = 3_000;
  const health = new ProviderHealthState(() => now);
  health.recordFailure();

  now += FAILURE_WINDOW_MS;
  const snapshot = health.getStatus();
  assert.deepEqual(snapshot, { failures: 0, cooling_until: null });
});

test("ten failures inside one five-minute window start a cooldown", async () => {
  let now = 2_000;
  const health = new ProviderHealthState(() => now);

  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    now += 20_000;
    health.recordFailure();
  }

  const snapshot = health.getStatus();
  assert.equal(snapshot.failures, FAILURE_THRESHOLD);
  assert.equal(typeof snapshot.cooling_until, "number");
});

test("OpenAI statuses resolve to one failure scope each", () => {
  const scope = (status) => healthFailureScope(status, "openai");
  assert.equal(scope(400), "provider");
  assert.equal(scope(503), "provider");
  assert.equal(scope(402), "credential");
  assert.equal(scope(403), "credential");
  assert.equal(scope(401), undefined);
  assert.equal(scope(429), undefined);
  assert.equal(scope(500), undefined);
});

test("Anthropic statuses resolve to one failure scope each", () => {
  const scope = (status) => healthFailureScope(status, "anthropic");
  assert.equal(scope(500), "provider");
  assert.equal(scope(502), "provider");
  assert.equal(scope(503), "provider");
  assert.equal(scope(529), "provider");
  assert.equal(scope(401), "credential");
  assert.equal(scope(403), "credential");
  assert.equal(scope(402), undefined);
  assert.equal(scope(400), undefined);
  assert.equal(scope(429), undefined);
});

test("statuses outside the failure maps are not counted", () => {
  for (const protocol of ["openai", "anthropic"]) {
    for (const status of [200, 201, 301, 404, 408, 418, 501]) {
      assert.equal(
        healthFailureScope(status, protocol),
        undefined,
        `status ${status} on ${protocol} should not affect health`,
      );
    }
  }
});

test("a first key failure starts a 30-minute cooldown that expires normally", () => {
  let now = 10_000;
  const health = new ProviderHealthState(() => now);
  const snapshot = health.recordImmediateFailure();
  assert.deepEqual(snapshot, {
    failures: 1,
    cooling_until: now + COOLDOWN_MS,
  });

  now += COOLDOWN_MS;
  assert.deepEqual(health.getStatus(), { failures: 0, cooling_until: null });
});

test("a repeated key failure refreshes the full 30-minute cooldown", () => {
  let now = 20_000;
  const health = new ProviderHealthState(() => now);
  health.recordImmediateFailure();

  now += 10 * 60 * 1000;
  const refreshed = health.recordImmediateFailure();
  assert.deepEqual(refreshed, {
    failures: 1,
    cooling_until: now + COOLDOWN_MS,
  });
});

test("catalog health is isolated from inference health", async () => {
  const objects = new Map([
    ["provider", new ProviderHealthState()],
    ["provider:catalog", new ProviderHealthState()],
  ]);
  const env = {
    HEALTH: {
      getByName: (name) => objects.get(name),
    },
  };
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    await recordProviderFailure(env, "provider", "test", "catalog");
  }
  assert.equal(await providerIsAvailable(env, "provider", "inference"), true);
  assert.equal(await providerIsAvailable(env, "provider", "catalog"), false);

  await clearProviderHealth(env, "provider", "catalog");
  assert.equal(await providerIsAvailable(env, "provider", "catalog"), true);
  assert.equal(await providerIsAvailable(env, "provider", "inference"), true);
});

test("catalog key cooldown is isolated from inference key cooldown", async () => {
  const objects = new Map([
    ["key:provider:credential", new ProviderHealthState()],
    ["key:provider:credential:catalog", new ProviderHealthState()],
  ]);
  const env = {
    HEALTH: {
      getByName: (name) => objects.get(name),
    },
  };

  await recordCredentialFailure(
    env,
    "provider",
    "credential",
    "test",
    "catalog",
  );
  assert.equal(
    await credentialIsAvailable(env, "provider", "credential", "inference"),
    true,
  );
  assert.equal(
    await credentialIsAvailable(env, "provider", "credential", "catalog"),
    false,
  );

  await clearCredentialHealth(env, "provider", "credential", "catalog");
  assert.equal(
    await credentialIsAvailable(env, "provider", "credential", "catalog"),
    true,
  );
  assert.equal(
    await credentialIsAvailable(env, "provider", "credential", "inference"),
    true,
  );
});

test("health listing preserves provider and key configuration order", async () => {
  const providers = [
    {
      id: "first",
      credentials: [{ id: "first-a" }, { id: "first-b" }],
    },
    {
      id: "second",
      credentials: [{ id: "second-a" }],
    },
  ];
  const objects = new Map();
  const get = (name) => {
    if (!objects.has(name)) {
      objects.set(name, new ProviderHealthState());
    }
    return objects.get(name);
  };
  const env = { HEALTH: { getByName: get } };
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    get("first").recordFailure();
  }
  get("key:first:first-b").recordImmediateFailure();
  get("key:second:second-a").recordImmediateFailure();

  const cooling = await listCoolingHealth(env, providers);
  assert.deepEqual(
    cooling.map((entry) => [entry.provider_id, entry.credential_id ?? null]),
    [
      ["first", null],
      ["first", "first-b"],
      ["second", "second-a"],
    ],
  );
});

test("stored state recreates an active cooldown after an eviction", () => {
  let now = 5_000;
  const original = new ProviderHealthState(() => now);
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    original.recordFailure();
  }

  const stored = original.getStoredState();
  assert(stored);
  const recreated = new ProviderHealthState(() => now, stored);
  assert.deepEqual(recreated.getStatus(), original.getStatus());

  now += FAILURE_WINDOW_MS;
  assert.equal(recreated.getStatus().cooling_until, stored.cooling_until);
});

test("cooldown status fan-out uses the provider concurrency limit", async () => {
  const providerIds = Array.from(
    { length: PROVIDER_FAN_OUT_CONCURRENCY * 2 },
    (_, index) => `provider-${index}`,
  );
  let active = 0;
  let maximumActive = 0;
  const env = {
    HEALTH: {
      getByName: () => ({
        getStatus: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return {
            failures: FAILURE_THRESHOLD,
            cooling_until: Date.now() + 60_000,
          };
        },
      }),
    },
  };

  const cooling = await listCoolingProviders(env, providerIds);

  assert.equal(cooling.length, providerIds.length);
  assert.equal(maximumActive, PROVIDER_FAN_OUT_CONCURRENCY);
});

test("health updates use waitUntil when it is available", async () => {
  let scheduled;
  const context = {
    waitUntil: (promise) => {
      scheduled = promise;
    },
  };
  let completed = false;
  await scheduleHealthUpdate(
    context,
    Promise.resolve().then(() => {
      completed = true;
    }),
  );
  assert(scheduled instanceof Promise);
  assert.equal(completed, true);
});

test("health updates fall back to awaiting when waitUntil is unavailable to an event", async () => {
  let completed = false;
  await scheduleHealthUpdate(
    {
      waitUntil() {
        throw new Error("event already completed");
      },
    },
    Promise.resolve().then(() => {
      completed = true;
    }),
  );
  assert.equal(completed, true);
});
