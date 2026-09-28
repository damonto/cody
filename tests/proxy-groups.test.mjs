import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./admin/fixtures.ts";
import { proxyGroupSnapshot } from "../src/gateway/proxies/configuration.ts";
import { reconcileBindingOwners } from "../src/gateway/proxies/binding-owners.ts";
import {
  chooseProxy,
  freshProxyHealth,
  currentProxyHealth,
  observeProxyHealth,
  PROXY_COOLDOWN_MS,
} from "../src/gateway/proxies/policy.ts";

test("unrelated revisions and owner ordering do not rescan bindings, but advance the fence", () => {
  const a = { provider_id: "a" };
  const b = { provider_id: "b" };
  const group = { revision: 1, owners: [a, b] };
  const first = reconcileBindingOwners(group);
  const reordered = reconcileBindingOwners(
    { ...group, owners: [b, a, a] },
    first.owners,
  );
  assert.equal(reordered.write, false);
  assert.equal(reordered.prune, false);
  const newer = reconcileBindingOwners({ ...group, revision: 2 }, first.owners);
  assert.equal(newer.write, true);
  assert.equal(newer.prune, false);
  assert.equal(newer.owners.revision, 2);
  assert.equal(
    reconcileBindingOwners({ revision: 1, owners: [a] }, newer.owners).status,
    "stale_configuration",
  );
  assert.equal(
    reconcileBindingOwners({ revision: 3, owners: [a] }, newer.owners).prune,
    true,
  );
});

test("binding owners follow inheritance, overrides, direct access and removals", async () => {
  const input = config();
  const provider = input.providers[0];
  provider.proxy_group = "old";
  provider.credentials = [
    ...["one", "two"].map((id) => ({ ...provider.credentials[0], id })),
    { ...provider.credentials[0], id: "override", proxy_group: "old" },
    { ...provider.credentials[0], id: "direct", proxy_group: null },
  ];
  const group = { id: "old", strategy: "sticky", proxies: [] };
  const owners = async () => (await proxyGroupSnapshot(input, group)).owners;
  assert.deepEqual(await owners(), [
    { provider_id: "provider" },
    { provider_id: "provider", credential_id: "override" },
  ]);
  provider.disabled = true;
  provider.credentials.forEach((credential) => {
    credential.disabled = true;
  });
  assert.equal((await owners()).length, 2);
  provider.proxy_group = "new";
  assert.deepEqual(await owners(), [
    { provider_id: "provider", credential_id: "override" },
  ]);
  provider.credentials = provider.credentials.filter(
    (credential) => credential.id !== "override",
  );
  assert.deepEqual(await owners(), []);
  provider.proxy_group = "old";
  input.providers = [];
  assert.deepEqual(await owners(), []);
});

test("random and sticky ignore priority; priority chooses only the highest tier", () => {
  const nodes = [
    { id: "low", priority: -5 },
    { id: "high-a", priority: 100 },
    { id: "high-b", priority: 100 },
  ];
  for (const strategy of ["random", "sticky"]) {
    assert.equal(chooseProxy(nodes, strategy, () => 0).id, "low");
    assert.equal(chooseProxy(nodes, strategy, () => 0.999).id, "high-b");
  }
  assert.equal(chooseProxy(nodes, "priority", () => 0).id, "high-a");
  assert.equal(chooseProxy(nodes, "priority", () => 0.999).id, "high-b");
  assert.equal(chooseProxy([], "random"), undefined);
});

function outcome(health, at, result = "failure") {
  return {
    lease: { proxy_id: "node", generation: health.generation },
    event_id: crypto.randomUUID(),
    observed_at: at,
    outcome: result,
  };
}

test("three distinct failures within a minute persist a five-minute cooldown", () => {
  let health = freshProxyHealth();
  const first = outcome(health, 100_000);
  health = observeProxyHealth(health, first, 100_000);
  health = observeProxyHealth(health, first, 100_001);
  assert.equal(health.failures.length, 1);
  const old = health;
  health = observeProxyHealth(health, outcome(health, 110_000), 110_000);
  health = observeProxyHealth(health, outcome(health, 120_000), 120_000);
  assert.equal(health.cooling_until, 120_000 + PROXY_COOLDOWN_MS);
  assert.notEqual(health.generation, old.generation);
  assert.deepEqual(
    observeProxyHealth(health, outcome(old, 120_001, "success"), 120_001),
    health,
  );
  assert.equal(
    currentProxyHealth(health, 120_000 + PROXY_COOLDOWN_MS - 1).cooling_until,
    health.cooling_until,
  );
  assert.equal(
    currentProxyHealth(health, 120_000 + PROXY_COOLDOWN_MS).cooling_until,
    null,
  );
});

test("success, elapsed windows and delayed results cannot manufacture a failure streak", () => {
  let health = freshProxyHealth();
  const generation = health.generation;
  health = observeProxyHealth(health, outcome(health, 100_000), 100_000);
  health = observeProxyHealth(health, outcome(health, 160_000), 160_000);
  assert.equal(health.failures.length, 1);
  health = observeProxyHealth(
    health,
    outcome(health, 165_000, "success"),
    165_000,
  );
  assert.equal(health.failures.length, 0);
  health = observeProxyHealth(health, outcome(health, 164_000), 166_000);
  assert.equal(health.failures.length, 0);
  health = observeProxyHealth(health, outcome(health, 170_000), 170_000);
  health = observeProxyHealth(
    health,
    outcome(health, 166_000, "success"),
    171_000,
  );
  assert.equal(
    health.failures.length,
    1,
    "a late success retains failures observed after it",
  );
  const reset = freshProxyHealth();
  assert.notEqual(generation, reset.generation);
  assert.deepEqual(
    observeProxyHealth(reset, outcome(health, 180_000), 180_000),
    reset,
  );
});
