import assert from "node:assert/strict";
import type { ProxyGroupObject } from "../../src/platform/bindings.ts";
import type { ProxyGroupSnapshot } from "../../src/gateway/proxies/schema.ts";

/** Run against both durable implementations, including a fresh object instance. */
export async function proxyBindingLifecycle(
  stub: ProxyGroupObject,
  reopen: () => Promise<ProxyGroupObject>,
  id: string,
): Promise<void> {
  const inherited = { provider_id: "provider" };
  const override = { provider_id: "provider", credential_id: "override" };
  const group: ProxyGroupSnapshot = {
    id,
    revision: 1,
    strategy: "sticky",
    owners: [inherited, override],
    proxies: [
      { id: "node", fingerprint: "a".repeat(64), priority: 1, disabled: false },
    ],
  };
  const { owners: _initialOwners, ...legacy } = group;
  await stub.select({
    group: legacy,
    owner: { provider_id: "deleted-provider" },
  });
  assert.equal((await stub.getStatus(legacy)).bindings.length, 1);
  await stub.select({ group, owner: inherited });
  await stub.select({ group, owner: override });
  const before = await stub.getStatus(group);
  assert.equal(before.bindings.length, 2);
  const old = structuredClone(group);
  group.revision++;
  group.owners = [override];
  const after = await stub.getStatus(group);
  assert.deepEqual(
    after.bindings,
    before.bindings.filter((binding) => binding.credential_id === "override"),
  );
  assert.deepEqual(after.proxies, before.proxies);
  stub = await reopen();
  assert.deepEqual(await stub.select({ group: old, owner: inherited }), {
    status: "stale_configuration",
  });
  assert.deepEqual(await stub.select({ group, owner: inherited }), {
    status: "unavailable",
  });
  // Pre-publication OAuth may still connect, but cannot restore a removed binding.
  const { owners: _owners, ...partial } = old;
  assert.equal(
    (await stub.select({ group: partial, owner: inherited })).status,
    "selected",
  );
  assert.deepEqual((await stub.getStatus(group)).bindings, after.bindings);
  group.revision++;
  group.owners = [];
  assert.deepEqual((await stub.getStatus(group)).bindings, []);
  // A legitimate later publication can assign the owner again.
  group.revision++;
  group.owners = [inherited];
  assert.equal(
    (await stub.select({ group, owner: inherited })).status,
    "selected",
  );
  assert.equal((await stub.getStatus(group)).bindings.length, 1);

  // Temporary request exclusions do not replace a healthy sticky binding.
  const selection = await stub.select({ group, owner: inherited });
  assert.equal(selection.status, "selected");
  if (selection.status !== "selected") throw new Error("Missing proxy lease");
  const oldGroup = structuredClone(group);
  group.revision++;
  group.proxies.push({
    id: "other",
    fingerprint: "b".repeat(64),
    priority: 1,
    disabled: false,
  });
  const temporary = await stub.select({
    group,
    owner: inherited,
    exclude: ["node"],
  });
  assert.equal(temporary.status, "selected");
  if (temporary.status !== "selected")
    throw new Error("Missing alternate proxy");
  assert.equal(temporary.lease.proxy_id, "other");
  assert.equal((await stub.getStatus(group)).bindings[0]?.proxy_id, "node");
  assert.equal(
    (await stub.select({ group: oldGroup, owner: inherited })).status,
    "stale_configuration",
  );

  // Changed endpoints invalidate outstanding health reports on both platforms.
  group.revision++;
  group.proxies[0]!.fingerprint = "c".repeat(64);
  await stub.getStatus(group);
  for (let i = 0; i < 3; i++)
    await stub.observe({
      lease: selection.lease,
      event_id: crypto.randomUUID(),
      outcome: "failure",
      observed_at: Date.now(),
    });
  assert.equal(
    (await stub.getStatus(group)).proxies.find((node) => node.id === "node")
      ?.status,
    "healthy",
  );
  group.revision++;
  group.strategy = "random";
  assert.deepEqual((await stub.getStatus(group)).bindings, []);
  stub = await reopen();
  assert.deepEqual((await stub.getStatus(group)).bindings, []);
}
