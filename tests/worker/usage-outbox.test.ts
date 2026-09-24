import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ingestUsage, requestDetail } from "../../src/reporting/store.ts";
import { RequestMeter } from "../../src/telemetry/meter.ts";
import type { UsageOutbox } from "../../src/platform/cloudflare/objects.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";
import { usage } from "../admin/fixtures.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeAll(async () => {
  await applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

test.each(["D1", "Queue"])(
  "%s failure retains only failed journal entries and does not block the other destination",
  async (destination) => {
    const outbox = env.USAGE_OUTBOX.getByName(`independent-${destination}`);
    const finished = usage(`independent-${destination}`, Date.now());
    const progress: UsageEvent = {
      ...finished,
      phase: "started",
      sequence: 1,
      outcome: "pending",
      finished_at: null,
      duration_ms: null,
    };
    await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
      const bindings = Reflect.get(instance, "env") as Env;
      const queue: Queue<UsageEvent> = bindings.USAGE_QUEUE;
      let failing = true;
      const batch = bindings.CODY_DB.batch.bind(bindings.CODY_DB);
      const write = vi
        .spyOn(bindings.CODY_DB, "batch")
        .mockImplementation(async (statements) => {
          if (failing && destination === "D1") {
            throw new Error("D1 unavailable");
          }
          return batch(statements);
        });
      const send = vi.spyOn(queue, "sendBatch").mockImplementation(async () => {
        if (failing && destination === "Queue") {
          throw new Error("Queue unavailable");
        }
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      });
      await state.storage.put({
        [`event:${finished.request_id}:1`]: progress,
        [`event:${finished.request_id}:2`]: finished,
      });
      await instance.alarm();
      expect(write).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledExactlyOnceWith([
        { body: finished, contentType: "json" },
      ]);
      expect([
        ...(
          await state.storage.list<UsageEvent>({ prefix: "event:" })
        ).values(),
      ]).toEqual([destination === "D1" ? progress : finished]);
      expect(await state.storage.getAlarm()).not.toBeNull();

      failing = false;
      await instance.alarm();
      expect(write).toHaveBeenCalledTimes(destination === "D1" ? 2 : 1);
      expect(send).toHaveBeenCalledTimes(destination === "Queue" ? 2 : 1);
      expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  },
);

test.each([false, true])(
  "large retry records respect Queue byte limits and retry only failed batches (%s)",
  async (failSecondBatch) => {
    const outbox = env.USAGE_OUTBOX.getByName(
      `large-queue-batches-${failSecondBatch}`,
    );
    const template = usage("large-template", Date.now());
    const attempt = template.attempts.at(0);
    if (!attempt) {
      throw new Error("The usage fixture must contain an attempt");
    }
    template.reported_model = "模型".repeat(100);
    template.attempts = Array.from({ length: 20 }, (_, index) => ({
      ...attempt,
      attempt: index + 1,
    }));
    const records = Array.from({ length: 25 }, (_, index) => ({
      ...template,
      request_id: `large-${String(index).padStart(2, "0")}`,
    }));
    const size = (event: UsageEvent) =>
      new TextEncoder().encode(JSON.stringify(event)).byteLength + 100;
    expect(
      records.reduce((total, event) => total + size(event), 0),
    ).toBeGreaterThan(256_000);
    await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
      const bindings = Reflect.get(instance, "env") as Env;
      const queue: Queue<UsageEvent> = bindings.USAGE_QUEUE;
      const delivered: UsageEvent[][] = [];
      let calls = 0;
      vi.spyOn(queue, "sendBatch").mockImplementation(async (messages) => {
        const events = [...messages].map((message) => message.body);
        if (events.reduce((total, event) => total + size(event), 0) > 256_000) {
          throw new Error("Queue batch exceeds 256 KB");
        }
        calls++;
        if (failSecondBatch && calls === 2) {
          throw new Error("Queue unavailable for the second batch");
        }
        delivered.push(events);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      });
      await state.storage.put(
        Object.fromEntries(
          records.map((event) => [`event:${event.request_id}:2`, event]),
        ),
      );
      await instance.alarm();
      if (failSecondBatch) {
        expect(
          (await state.storage.list({ prefix: "event:" })).size,
        ).toBeGreaterThan(0);
        await instance.alarm();
      }
      expect(delivered.flat()).toHaveLength(records.length);
      expect(delivered.flat()).toEqual(records);
      expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  },
);

test("invalid persisted progress is retained without blocking final usage", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("invalid-progress");
  const finished = usage("valid-final", Date.now());
  const invalid = {
    ...finished,
    request_id: "invalid-progress",
    phase: "invalid",
  };
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const send = vi.spyOn(bindings.USAGE_QUEUE, "sendBatch");
    await state.storage.put({
      "event:invalid-progress:1": invalid,
      "event:valid-final:2": finished,
    });
    await instance.alarm();
    expect(send).toHaveBeenCalledExactlyOnceWith([
      { body: finished, contentType: "json" },
    ]);
    expect(await state.storage.get("event:invalid-progress:1")).toEqual(
      invalid,
    );
    expect(await state.storage.get("event:valid-final:2")).toBeUndefined();
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});

test("a failed progress backlog cannot starve final usage after eviction", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("fair-journal-recovery");
  const finished = usage("z-final", Date.now());
  const progress = Array.from({ length: 125 }, (_, index): UsageEvent => ({
    ...finished,
    request_id: `a-progress-${String(index).padStart(3, "0")}`,
    phase: "started",
    sequence: 1,
    outcome: "pending",
    finished_at: null,
    duration_ms: null,
  }));
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    vi.spyOn(bindings.CODY_DB, "batch").mockRejectedValue(
      new Error("D1 unavailable"),
    );
    await state.storage.put({
      ...Object.fromEntries(
        progress.map((event) => [`event:${event.request_id}:1`, event]),
      ),
      "event:z-final:2": finished,
    });
    await instance.alarm();
    expect(await state.storage.get("event:z-final:2")).toEqual(finished);
  });
  vi.restoreAllMocks();
  await evictDurableObject(outbox);
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    vi.spyOn(bindings.CODY_DB, "batch").mockRejectedValue(
      new Error("D1 unavailable"),
    );
    const send = vi.spyOn(bindings.USAGE_QUEUE, "sendBatch");
    await instance.alarm();
    expect(send).toHaveBeenCalledExactlyOnceWith([
      { body: finished, contentType: "json" },
    ]);
    expect((await state.storage.list({ prefix: "event:" })).size).toBe(125);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});

test.each(["responses", "messages"] as const)(
  "%s progress stays visible in D1 while only final usage enters the Queue",
  async (endpoint) => {
    const requestId = `one-queue-message-${endpoint}`;
    const outbox = env.USAGE_OUTBOX.getByName(requestId);
    const queued: UsageEvent[] = [];
    await runInDurableObject(outbox, async (instance: UsageOutbox) => {
      const bindings = Reflect.get(instance, "env") as Env;
      vi.spyOn(bindings.USAGE_QUEUE, "sendBatch").mockImplementation(
        async (messages) => {
          queued.push(
            ...[...messages].map((message) => message.body as UsageEvent),
          );
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      );
    });
    const meter = new RequestMeter({
      requestId,
      endpoint,
      method: "POST",
      protocol: endpoint === "messages" ? "anthropic" : "openai",
      sink: { send: (event) => outbox.enqueue(event) },
    });
    await meter.drain();
    await expect
      .poll(() => requestDetail(env.CODY_DB, requestId))
      .toMatchObject({ phase: "started", sequence: 0 });

    meter.authenticate("client");
    meter.requestedModel("alias");
    meter.select({
      providerId: "provider",
      credentialId: "primary",
      model: "real-model",
    });
    const selected = meter.checkpoint();
    await meter.drain();
    await expect
      .poll(() => requestDetail(env.CODY_DB, requestId))
      .toEqual(selected);
    expect(queued).toEqual([]);

    meter.observe({ usage: { input_tokens: 100, output_tokens: 20 } });
    const finished = meter.finish("success", 200);
    await meter.drain();
    await expect.poll(() => queued).toEqual([finished]);
    await ingestUsage(env.CODY_DB, queued[0]);

    // A delayed progress write from the journal cannot replace final usage.
    await outbox.enqueue(selected);
    await runInDurableObject(outbox, (instance: UsageOutbox) =>
      instance.alarm(),
    );
    expect(await requestDetail(env.CODY_DB, requestId)).toEqual(finished);
    expect(queued).toEqual([finished]);
  },
);

test("progress survives D1 failure and eviction without Queue writes", async () => {
  const requestId = "durable-progress";
  const outbox = env.USAGE_OUTBOX.getByName(requestId);
  const meter = new RequestMeter({
    requestId,
    endpoint: "responses",
    method: "POST",
    protocol: "openai",
    sink: { send: async () => {} },
  });
  const event = meter.checkpoint();
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const write = vi
      .spyOn(bindings.CODY_DB, "batch")
      .mockRejectedValue(new Error("D1 unavailable"));
    const send = vi.spyOn(bindings.USAGE_QUEUE, "sendBatch");
    await state.storage.put(`event:${requestId}:0`, event);
    await instance.alarm();
    expect(write).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(await state.storage.get(`event:${requestId}:0`)).toEqual(event);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  vi.restoreAllMocks();
  await evictDurableObject(outbox);
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const send = vi.spyOn(bindings.USAGE_QUEUE, "sendBatch");
    await instance.alarm();
    expect(send).not.toHaveBeenCalled();
    expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect(await requestDetail(env.CODY_DB, requestId)).toEqual(event);
});

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
