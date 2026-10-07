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

function futureClockStart(): number {
  // Mocking Date.now does not change workerd's alarm clock. Keep scheduled
  // times in the future so storage does not clamp past alarms to real time.
  return new Date(Date.now() + 24 * 60 * 60_000).setUTCHours(10, 0, 0, 0);
}

async function advancePastBackoff(
  storage: DurableObjectStorage,
): Promise<void> {
  const retries = await storage.get<{ until: number }>([
    "delivery-retry:d1",
    "delivery-retry:queue",
  ]);
  const now =
    Math.max(Date.now(), ...[...retries.values()].map((retry) => retry.until)) +
    1;
  vi.spyOn(Date, "now").mockReturnValue(now);
}

test.each(["D1", "Queue"])(
  "%s failure retains only failed journal entries and does not block the other destination",
  async (destination) => {
    const outbox = env.USAGE_OUTBOX.getByName(`independent-${destination}`);
    const finished = usage(`independent-${destination}`, Date.now());
    finished.upstream_observation = {
      request: { model: "real-model", reasoning: { effort: "high" } },
      response: { model: "real-model-v2", reasoning: { effort: "low" } },
    };
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
      await advancePastBackoff(state.storage);
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
        await advancePastBackoff(state.storage);
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
    await advancePastBackoff(state.storage);
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
  await runInDurableObject(outbox, async (instance, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const send = bindings.USAGE_QUEUE.sendBatch.bind(bindings.USAGE_QUEUE);
    vi.spyOn(bindings.USAGE_QUEUE, "sendBatch").mockImplementation(
      async (messages) => {
        const batch = [...messages];
        delivered.push(...batch.map((message) => message.body as UsageEvent));
        return send(batch);
      },
    );
    await advancePastBackoff(state.storage);
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

test("new records honor persisted Queue backoff while D1 remains available", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("backoff-isolation");
  const first = usage("backoff-first", Date.now());
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const send = vi
      .spyOn(bindings.USAGE_QUEUE, "sendBatch")
      .mockRejectedValue(new Error("Queue unavailable"));
    await instance.enqueue(first);
    await instance.alarm();
    expect(send).toHaveBeenCalledTimes(1);
    const retry = await state.storage.get<{ failures: number; until: number }>(
      "delivery-retry:queue",
    );
    expect(retry?.failures).toBe(1);
  });
  vi.restoreAllMocks();
  await evictDurableObject(outbox);
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const retry = await state.storage.get<{ failures: number; until: number }>(
      "delivery-retry:queue",
    );
    vi.spyOn(Date, "now").mockReturnValue(retry!.until - 1);
    const send = vi.spyOn(bindings.USAGE_QUEUE, "sendBatch").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    await instance.enqueue({ ...first, request_id: "backoff-second" });
    const progress: UsageEvent = {
      ...first,
      request_id: "backoff-progress",
      attempts: [],
      sequence: 1,
      phase: "started",
      finished_at: null,
      outcome: "pending",
      duration_ms: null,
    };
    await instance.enqueue(progress);
    await instance.alarm();
    expect(send).not.toHaveBeenCalled();
    expect(await requestDetail(bindings.CODY_DB, progress.request_id)).toEqual(
      progress,
    );
    expect(await state.storage.get("delivery-retry:queue")).toEqual(retry);
    await advancePastBackoff(state.storage);
    await instance.alarm();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
    expect(await state.storage.get("delivery-retry:queue")).toBeUndefined();
  });
});

test("repeated failures back off exponentially with a bounded delay and recover", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("bounded-backoff");
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    const send = vi
      .spyOn(bindings.USAGE_QUEUE, "sendBatch")
      .mockRejectedValue(new Error("Queue unavailable"));
    const event = usage("backoff-bounded-record", Date.now());
    await state.storage.put(`event:${event.request_id}:2`, event);
    for (let attempt = 1; attempt <= 12; attempt++) {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await state.storage.deleteAlarm();
      await instance.alarm();
      const retry = await state.storage.get<{
        failures: number;
        until: number;
      }>("delivery-retry:queue");
      const delay = Math.min(3_600_000, 10_000 * 2 ** (attempt - 1));
      expect(retry?.failures).toBe(attempt);
      expect(retry!.until - now).toBeGreaterThanOrEqual(delay * 0.75);
      expect(retry!.until - now).toBeLessThanOrEqual(delay);
      expect(await state.storage.getAlarm()).toBe(retry!.until);
      await instance.alarm();
      expect(send).toHaveBeenCalledTimes(attempt);
      await advancePastBackoff(state.storage);
    }
    send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    await instance.alarm();
    expect(await state.storage.get("delivery-retry:queue")).toBeUndefined();
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

test.each([
  ["queue", "Queue send failed: 10253 FreeTierLimitExceeded"],
  ["d1", "D1_ERROR: Your account has exceeded its daily write limit"],
] as const)(
  "%s daily limits wait for the next UTC reset",
  async (destination, message) => {
    const outbox = env.USAGE_OUTBOX.getByName(`daily-limit-${destination}`);
    const now = futureClockStart();
    const reset = new Date(now).setUTCHours(24, 0, 0, 0);
    await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      const bindings = Reflect.get(instance, "env") as Env;
      const operation =
        destination === "queue"
          ? vi
              .spyOn(bindings.USAGE_QUEUE, "sendBatch")
              .mockRejectedValue(new Error(message))
          : vi
              .spyOn(bindings.CODY_DB, "batch")
              .mockRejectedValue(new Error(message));
      const finished = usage(`daily-limit-${destination}`, now);
      const event: UsageEvent =
        destination === "queue"
          ? finished
          : {
              ...finished,
              phase: "started",
              sequence: 1,
              finished_at: null,
              outcome: "pending",
              duration_ms: null,
            };
      await state.storage.put(
        `event:${event.request_id}:${event.sequence}`,
        event,
      );
      await instance.alarm();
      const retry = await state.storage.get<{ until: number }>(
        `delivery-retry:${destination}`,
      );
      expect(retry!.until).toBeGreaterThan(reset);
      expect(retry!.until).toBeLessThanOrEqual(reset + 61_000);
      await instance.enqueue({
        ...event,
        request_id: event.request_id + "-new",
      });
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(operation).toHaveBeenCalledTimes(1);
      expect(await state.storage.getAlarm()).toBe(retry!.until);
      expect((await state.storage.list({ prefix: "event:" })).size).toBe(2);
    });
  },
);

test("a retry expiring during a scan does not strand earlier progress behind Queue backoff", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("retry-expiring-mid-scan");
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const start = futureClockStart();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const finished = usage("mid-scan", start);
    const progress = (id: string): UsageEvent => ({
      ...finished,
      request_id: id,
      phase: "started",
      sequence: 1,
      finished_at: null,
      outcome: "pending",
      duration_ms: null,
    });
    await state.storage.put({
      "delivery-retry:d1": { failures: 1, until: start + 100 },
      "event:a-progress:1": progress("a-progress"),
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => {
          const id = `middle-${String(i).padStart(2, "0")}`;
          return [`event:${id}:2`, { ...finished, request_id: id }];
        }),
      ),
      "event:z-progress:1": progress("z-progress"),
    });
    const bindings = Reflect.get(instance, "env") as Env;
    const send = vi
      .spyOn(bindings.USAGE_QUEUE, "sendBatch")
      .mockImplementation(async () => {
        clock.mockReturnValue(start + 1000);
        throw new Error("10253 FreeTierLimitExceeded");
      });
    await instance.alarm();
    expect(await state.storage.get("event:a-progress:1")).toBeDefined();
    expect(await state.storage.get("event:z-progress:1")).toBeUndefined();
    expect(await state.storage.getAlarm()).toBeLessThanOrEqual(start + 11_000);
    clock.mockReturnValue(start + 11_001);
    await instance.alarm();
    expect(await state.storage.get("event:a-progress:1")).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

test.each(["d1", "queue"] as const)(
  "%s acknowledgement failure preserves the journal and retry state atomically",
  async (destination) => {
    const outbox = env.USAGE_OUTBOX.getByName(`ack-failure-${destination}`);
    await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const finished = usage(`ack-failure-${destination}`, now);
      const event: UsageEvent =
        destination === "queue"
          ? finished
          : {
              ...finished,
              phase: "started",
              sequence: 1,
              finished_at: null,
              outcome: "pending",
              duration_ms: null,
            };
      const key = `event:${event.request_id}:${event.sequence}`;
      const retryKey = `delivery-retry:${destination}`;
      const retry = { failures: 3, until: now - 1 };
      await state.storage.put({ [key]: event, [retryKey]: retry });
      const bindings = Reflect.get(instance, "env") as Env;
      const send = vi
        .spyOn(bindings.USAGE_QUEUE, "sendBatch")
        .mockResolvedValue({
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        });
      const write = vi.spyOn(bindings.CODY_DB, "batch");
      const transaction = state.storage.transaction.bind(state.storage);
      let failAcknowledgement = true;
      vi.spyOn(state.storage, "transaction").mockImplementation((operation) =>
        transaction(async (tx) => {
          const result = await operation(tx);
          if (failAcknowledgement && (await tx.get(key)) === undefined) {
            expect(await tx.get(retryKey)).toBeUndefined();
            failAcknowledgement = false;
            throw new Error("Local acknowledgement unavailable");
          }
          return result;
        }),
      );
      await instance.alarm();
      expect(failAcknowledgement).toBe(false);
      expect(await state.storage.get(key)).toEqual(event);
      expect(await state.storage.get(retryKey)).toEqual(retry);
      expect(await state.storage.getAlarm()).toBe(now + 10_000);
      await instance.alarm();
      expect(destination === "queue" ? send : write).toHaveBeenCalledTimes(2);
      expect(await state.storage.get(key)).toBeUndefined();
      expect(await state.storage.get(retryKey)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  },
);

test("a local failure waits for the other destination before releasing the flush", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("settle-both-destinations");
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const finished = usage("settle-finished", Date.now());
    const key = "event:settle-progress:1";
    await state.storage.put({
      [key]: {
        ...finished,
        request_id: "settle-progress",
        phase: "started",
        sequence: 1,
        finished_at: null,
        outcome: "pending",
        duration_ms: null,
      },
      "event:settle-finished:2": finished,
    });
    const bindings = Reflect.get(instance, "env") as Env;
    let releaseQueue: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const send = vi
      .spyOn(bindings.USAGE_QUEUE, "sendBatch")
      .mockImplementation(async () => {
        await queued;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      });
    const write = vi.spyOn(bindings.CODY_DB, "batch");
    const transaction = state.storage.transaction.bind(state.storage);
    let failed = false;
    vi.spyOn(state.storage, "transaction").mockImplementation((operation) =>
      transaction(async (tx) => {
        const result = await operation(tx);
        if (!failed && (await tx.get(key)) === undefined) {
          failed = true;
          throw new Error("Local acknowledgement unavailable");
        }
        return result;
      }),
    );
    let completed = false;
    const first = instance.alarm().then(() => {
      completed = true;
    });
    await expect.poll(() => failed).toBe(true);
    const second = instance.alarm();
    expect(completed).toBe(false);
    releaseQueue?.();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await state.storage.get(key)).toBeDefined();
    expect(await state.storage.get("event:settle-finished:2")).toBeUndefined();
  });
});

test("a completed scan replaces an early recovery alarm with the persisted quota deadline", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("replace-early-alarm");
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const now = Date.now();
    const bindings = Reflect.get(instance, "env") as Env;
    vi.spyOn(bindings.USAGE_QUEUE, "sendBatch").mockRejectedValue(
      new Error("Queue rejected send", { cause: { code: 10253 } }),
    );
    await instance.enqueue(usage("replace-early-alarm", now));
    await instance.alarm();
    const retry = await state.storage.get<{ until: number }>(
      "delivery-retry:queue",
    );
    expect(retry!.until).toBeGreaterThan(now + 10_000);
    expect(await state.storage.getAlarm()).toBe(retry!.until);
  });
});

test("eligible enqueues during a scan retain a prompt wakeup behind its cursor", async () => {
  const outbox = env.USAGE_OUTBOX.getByName("enqueue-during-flush");
  await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const finished = usage("z-enqueue-during-flush", now);
    const progress: UsageEvent = {
      ...finished,
      request_id: "a-late-progress",
      phase: "started",
      sequence: 1,
      finished_at: null,
      outcome: "pending",
      duration_ms: null,
    };
    await state.storage.put(`event:${finished.request_id}:2`, finished);
    const bindings = Reflect.get(instance, "env") as Env;
    const send = vi
      .spyOn(bindings.USAGE_QUEUE, "sendBatch")
      .mockImplementation(async () => {
        await instance.enqueue(progress);
        throw new Error("10253 FreeTierLimitExceeded");
      });
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBe(now + 10_000);
    expect(await state.storage.get("event:a-late-progress:1")).toBeDefined();
    await instance.alarm();
    expect(await state.storage.get("event:a-late-progress:1")).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await state.storage.getAlarm()).toBeGreaterThan(now + 10_000);
  });
});

test.each([
  { failures: "corrupt", until: Number.MAX_SAFE_INTEGER },
  { failures: 1, until: null },
])(
  "malformed retry metadata cannot strand durable records (%j)",
  async (retry) => {
    const outbox = env.USAGE_OUTBOX.getByName(
      `malformed-retry-${String(retry.failures)}`,
    );
    await runInDurableObject(outbox, async (instance: UsageOutbox, state) => {
      const bindings = Reflect.get(instance, "env") as Env;
      const send = vi
        .spyOn(bindings.USAGE_QUEUE, "sendBatch")
        .mockResolvedValue({
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        });
      await state.storage.put("delivery-retry:queue", retry);
      await instance.enqueue(
        usage(`malformed-retry-${String(retry.failures)}`, Date.now()),
      );
      await instance.alarm();
      expect(send).toHaveBeenCalledTimes(1);
      expect((await state.storage.list({ prefix: "event:" })).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  },
);
