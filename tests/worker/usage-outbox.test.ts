import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { UsageOutbox } from "../../src/telemetry/outbox.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";
import { usage } from "../admin/fixtures.ts";

afterEach(() => vi.restoreAllMocks());

test.each(["auxiliary", "catalog", "handshake"])(
  "%s usage never enters the journal or Queue",
  async (kind) => {
    const outbox = env.USAGE_OUTBOX.getByName(`ignored-${kind}`);
    const event = { ...usage(`ignored-${kind}`, Date.now()), kind };
    await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
      const bindings = Reflect.get(instance, "env") as Env;
      const send = vi.spyOn(bindings.USAGE_QUEUE, "sendBatch");
      await instance.enqueue(event as unknown as UsageEvent);
      expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();

      // Also reject records already persisted by an older producer.
      await state.storage.put(`event:${event.request_id}:2`, event);
      await instance.alarm();
      expect(send).not.toHaveBeenCalled();
      expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  },
);

test("mixed journal batches deliver only inference records", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("mixed-usage-kinds");
  const inference = usage("inference-only", Date.now());
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const send = vi.spyOn(bindings.USAGE_QUEUE, "sendBatch");
    await state.storage.put({
      "event:inference-only:2": inference,
      "event:ignored:2": {
        ...inference,
        request_id: "ignored",
        kind: "catalog",
      },
    });
    await instance.alarm();
    expect(send).toHaveBeenCalledExactlyOnceWith([
      { body: inference, contentType: "json" },
    ]);
    expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

test("HTTP usage survives queue failure and eviction, then delivers the original record", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("queue-failure-test");
  const event = usage("durable-http-request", Date.now() - 1000);
  let attempts = 0;
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    vi.spyOn(bindings.USAGE_QUEUE, "sendBatch").mockImplementation(async () => {
      attempts++;
      expect((await state.storage.list({ prefix: "event:" })).size).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
      throw new Error("queue unavailable");
    });
  });
  await Promise.all([outbox.enqueue(event), outbox.enqueue(event)]);
  await expect.poll(() => attempts).toBeGreaterThan(0);
  await runInDurableObject(outbox, async (_instance, state) => {
    expect(
      [...(await state.storage.list<UsageEvent>({ prefix: "event:" }))].map(
        ([, value]) => value,
      ),
    ).toEqual([event]);
  });
  vi.restoreAllMocks();
  await evictDurableObject(outbox);
  const delivered: UsageEvent[] = [];
  await runInDurableObject(outbox, async (instance) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const send = bindings.USAGE_QUEUE.sendBatch.bind(bindings.USAGE_QUEUE);
    vi.spyOn(bindings.USAGE_QUEUE, "sendBatch").mockImplementation(
      async (messages) => {
        const batch = [...messages];
        delivered.push(...batch.map((message) => message.body as UsageEvent));
        return send(batch);
      },
    );
  });
  expect(await runDurableObjectAlarm(outbox)).toBe(true);
  expect(delivered).toEqual([event]);
  await runInDurableObject(outbox, async (_instance, state) => {
    expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

test("a failed journal transaction commits neither the event nor its recovery alarm", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("journal-failure-test");
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const transaction = state.storage.transaction.bind(state.storage);
    const spy = vi
      .spyOn(state.storage, "transaction")
      .mockImplementationOnce((operation) =>
        transaction(async (tx) => {
          await operation(tx);
          throw new Error("journal unavailable");
        }),
      );
    try {
      await expect(
        instance.enqueue(usage("uncommitted", Date.now())),
      ).rejects.toThrow("journal unavailable");
    } finally {
      spy.mockRestore();
    }
    expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
