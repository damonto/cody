import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type {
  ProxyGroupSnapshot,
  ProxyLease,
  ProxyOwner,
} from "../../src/gateway/proxies/schema.ts";

function fixture(strategy: ProxyGroupSnapshot["strategy"] = "sticky") {
  const group: ProxyGroupSnapshot = {
    id: `group-${crypto.randomUUID()}`,
    revision: 1,
    strategy,
    proxies: ["a", "b", "c"].map((id, index) => ({
      id,
      fingerprint: String(index).repeat(64),
      priority: 100 - index,
      disabled: false,
    })),
  };
  const stub = env.PROXY_GROUP.getByName(group.id);
  const select = async (
    owner: ProxyOwner = { provider_id: "provider" },
    exclude: string[] = [],
  ): Promise<ProxyLease> => {
    const selected = await stub.select({ group, owner, exclude });
    if (selected.status !== "selected") throw new Error(selected.status);
    return selected.lease;
  };
  const fail = (lease: ProxyLease) =>
    stub.observe({
      lease,
      event_id: crypto.randomUUID(),
      observed_at: Date.now(),
      outcome: "failure",
    });
  return { group, stub, select, fail };
}

test("concurrent sticky assignments survive eviction, priority edits and added nodes", async () => {
  const f = fixture();
  const leases = await Promise.all(
    Array.from({ length: 12 }, () => f.select()),
  );
  expect(new Set(leases.map((lease) => lease.proxy_id)).size).toBe(1);
  await evictDurableObject(f.stub);
  expect(await f.select()).toEqual(leases[0]);
  f.group.revision++;
  f.group.proxies.forEach((node) => {
    node.priority *= -1;
  });
  f.group.proxies.push({
    id: "new",
    fingerprint: "f".repeat(64),
    priority: 10_000,
    disabled: false,
  });
  expect((await f.select()).proxy_id).toBe(leases[0].proxy_id);
  await f.select({ provider_id: "provider", credential_id: "key" });
  await f.select({ provider_id: "another", credential_id: "key" });
  expect((await f.stub.getStatus(f.group)).bindings).toHaveLength(3);
});

test("temporary fallback retains the pin until cooldown; recovery never switches it back", async () => {
  const f = fixture();
  const first = await f.select();
  await f.fail(first);
  const temporary = await f.select(undefined, [first.proxy_id]);
  expect(temporary.proxy_id).not.toBe(first.proxy_id);
  expect((await f.select()).proxy_id).toBe(first.proxy_id);
  await f.fail(first);
  await evictDurableObject(f.stub);
  await f.fail(first);
  const replacement = await f.select(undefined, [first.proxy_id]);
  await f.stub.observe({
    lease: first,
    event_id: crypto.randomUUID(),
    observed_at: Date.now(),
    outcome: "success",
  });
  expect(
    (await f.stub.getStatus(f.group)).proxies.find(
      (node) => node.id === first.proxy_id,
    )?.status,
  ).toBe("cooling");
  await evictDurableObject(f.stub);
  expect((await f.select()).proxy_id).toBe(replacement.proxy_id);
  await f.stub.clear(f.group, first.proxy_id);
  expect((await f.select()).proxy_id).toBe(replacement.proxy_id);
});

test("disabled and removed nodes invalidate bindings; stale configurations and outcomes cannot restore them", async () => {
  const f = fixture();
  const oldGroup = structuredClone(f.group);
  const first = await f.select();
  f.group.revision++;
  f.group.proxies.find((node) => node.id === first.proxy_id)!.disabled = true;
  const replacement = await f.select();
  expect(replacement.proxy_id).not.toBe(first.proxy_id);
  expect(
    (
      await f.stub.select({
        group: oldGroup,
        owner: { provider_id: "provider" },
      })
    ).status,
  ).toBe("stale_configuration");
  await f.fail(first);
  expect(
    (await f.stub.getStatus(f.group)).proxies.find(
      (node) => node.id === first.proxy_id,
    )?.failures,
  ).toBe(0);
  f.group.revision++;
  f.group.proxies = f.group.proxies.filter(
    (node) => node.id !== replacement.proxy_id,
  );
  expect((await f.select()).proxy_id).not.toBe(replacement.proxy_id);
});

test("priority ignores disabled/cooling nodes and empty groups return unavailable", async () => {
  const f = fixture("priority");
  const first = await f.select();
  expect(first.proxy_id).toBe("a");
  for (let i = 0; i < 3; i++) await f.fail(first);
  expect((await f.select()).proxy_id).toBe("b");
  f.group.revision++;
  f.group.proxies.find((node) => node.id === "b")!.disabled = true;
  expect((await f.select()).proxy_id).toBe("c");
  f.group.revision++;
  f.group.proxies = [];
  expect(
    (
      await f.stub.select({
        group: f.group,
        owner: { provider_id: "provider" },
      })
    ).status,
  ).toBe("unavailable");
});

test("rotating proxy connection details fences old health observations", async () => {
  const f = fixture("priority");
  const old = await f.select();
  f.group.revision++;
  f.group.proxies[0].fingerprint = "f".repeat(64);
  const current = await f.select();
  expect(current.generation).not.toBe(old.generation);
  for (let i = 0; i < 3; i++) await f.fail(old);
  expect((await f.stub.getStatus(f.group)).proxies[0].failures).toBe(0);
});
