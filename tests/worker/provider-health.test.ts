import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import { FAILURE_THRESHOLD } from "../../src/gateway/health/health.ts";

test("failure streaks and cooldowns survive Durable Object eviction", async () => {
  const stub = env.HEALTH.getByName("eviction-test");
  for (let index = 0; index < FAILURE_THRESHOLD - 1; index += 1) {
    await stub.recordFailure();
  }

  await evictDurableObject(stub);
  const cooling = await stub.recordFailure();
  expect(cooling.failures).toBe(FAILURE_THRESHOLD);
  expect(cooling.cooling_until).toBeTypeOf("number");

  await evictDurableObject(stub);
  expect(await stub.getStatus()).toEqual(cooling);

  await stub.clear();
  await evictDurableObject(stub);
  expect(await stub.getStatus()).toEqual({ failures: 0, cooling_until: null });
});

test("immediate key cooldown survives eviction and can be cleared", async () => {
  const stub = env.HEALTH.getByName(`key-cooldown-${crypto.randomUUID()}`);
  const cooling = await stub.recordImmediateFailure();
  expect(cooling.failures).toBe(1);
  expect(cooling.cooling_until).toBeTypeOf("number");

  await evictDurableObject(stub);
  expect(await stub.getStatus()).toEqual(cooling);

  expect(await stub.clear()).toEqual({ failures: 0, cooling_until: null });
  await evictDurableObject(stub);
  expect(await stub.getStatus()).toEqual({ failures: 0, cooling_until: null });
});

test("reset leases fence late owners and retain the same spend across eviction and takeover", async () => {
  const stub = env.HEALTH.getByName(`lease-${crypto.randomUUID()}`);
  const grants = await Promise.all([
    stub.claimLease("reset", 60000),
    stub.claimLease("reset", 60000),
  ]);
  expect(grants.filter(Boolean)).toHaveLength(1);
  const first = grants.find((grant) => grant !== null)!;
  const operation = {
    credential_id: "one",
    account_ref: crypto.randomUUID(),
    credit_id: "paid-credit",
    redeem_request_id: crypto.randomUUID(),
    cooling_until: Date.now() + 60000,
  };
  expect(
    await stub.prepareResetLease("reset", first.owner, operation, 60000),
  ).toEqual(operation);
  await runInDurableObject(stub, async (_instance, state) => {
    const lease =
      await state.storage.get<Record<string, unknown>>("lease:reset");
    await state.storage.put("lease:reset", { ...lease, until: 0 });
  });
  await evictDurableObject(stub);
  const second = (await stub.claimLease("reset", 60000))!;
  expect(second.owner).not.toBe(first.owner);
  expect(second.operation).toEqual(operation);
  await stub.releaseLease("reset", first.owner, 0, true);
  expect(await stub.claimLease("reset", 60000)).toBeNull();
  expect(
    await stub.prepareResetLease("reset", first.owner, operation, 60000),
  ).toBeNull();
  expect(
    await stub.prepareResetLease(
      "reset",
      second.owner,
      { ...operation, credit_id: "another" },
      60000,
    ),
  ).toEqual(operation);
  await stub.releaseLease("reset", second.owner, 0, false);
  const retry = (await stub.claimLease("reset", 60000))!;
  expect(retry.operation).toEqual(operation);
  await stub.releaseLease("reset", retry.owner, 0, true);
  expect((await stub.claimLease("reset", 60000))?.operation).toBeNull();
});

test("an expired preparation lease cannot start spending", async () => {
  const stub = env.HEALTH.getByName(`expired-${crypto.randomUUID()}`);
  const lease = (await stub.claimLease("reset", 0))!;
  expect(
    await stub.prepareResetLease(
      "reset",
      lease.owner,
      {
        credential_id: "one",
        account_ref: crypto.randomUUID(),
        credit_id: "credit",
        redeem_request_id: crypto.randomUUID(),
        cooling_until: Date.now() + 60000,
      },
      60000,
    ),
  ).toBeNull();
});

test("a late reset completion cannot clear a later quota cooldown", async () => {
  const stub = env.HEALTH.getByName(`reset-health-${crypto.randomUUID()}`);
  const first = Date.now() + 60000;
  await stub.recordCooldownUntil(first, "quota");
  await stub.recordCooldownUntil(first + 60000, "quota");
  expect(await stub.clearQuotaCooldownUntil(first)).toBe(false);
  expect((await stub.getStatus()).cooling_until).toBe(first + 60000);
  expect(await stub.clearQuotaCooldownUntil(first + 60000)).toBe(true);
  expect((await stub.getStatus()).cooling_until).toBeNull();
});
