import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  WebSocketStorage,
  type StoredWebSocketSession,
} from "../../src/gateway/websocket/storage.ts";
import { WebSocketUsage } from "../../src/gateway/websocket/usage.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";
import { usage } from "../admin/fixtures.ts";

afterEach(() => vi.restoreAllMocks());

const proxy = () => env.RESPONSES_WEBSOCKET.getByName(crypto.randomUUID());

function checkpoint(event: UsageEvent): UsageEvent {
  return {
    ...event,
    phase: "started",
    sequence: 1,
    finished_at: null,
    outcome: "pending",
  };
}

test("terminal records and their retry alarm commit or roll back together", async () => {
  await runInDurableObject(proxy(), async (_instance, state) => {
    const store = new WebSocketStorage(state.storage);
    const event = usage("atomic-websocket", Date.now());
    await store.checkpoint(checkpoint(event));
    const transaction = state.storage.transaction.bind(state.storage);
    const failure = vi
      .spyOn(state.storage, "transaction")
      .mockImplementationOnce((operation) =>
        transaction(async (tx) => {
          await operation(tx);
          throw new Error("injected transaction failure");
        }),
      );
    await expect(store.finish(event)).rejects.toThrow(
      "injected transaction failure",
    );
    failure.mockRestore();
    expect(await state.storage.get(`usage:${event.request_id}`)).toEqual(
      checkpoint(event),
    );
    expect((await store.pendingUsage()).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();

    await store.finish(event);
    expect(
      await state.storage.get(`usage:${event.request_id}`),
    ).toBeUndefined();
    expect([...(await store.pendingUsage()).values()]).toEqual([event]);
    expect(await state.storage.getAlarm()).not.toBeNull();
    await store.acknowledgeUsage(event.request_id);
  });
});

test("new traffic and acknowledgements preserve the oldest pending retry deadline", async () => {
  await runInDurableObject(proxy(), async (_instance, state) => {
    let now = Date.now();
    const store = new WebSocketStorage(state.storage, () => now);
    const first = usage("first-websocket", now);
    const second = usage("second-websocket", now);
    await store.finish(first);
    const deadline = await state.storage.getAlarm();
    expect(deadline).toBe(now + 10_000);
    now += 9_000;
    await store.finish(second);
    await store.scheduleAlarm();
    expect(await state.storage.getAlarm()).toBe(deadline);
    await store.acknowledgeUsage(second.request_id);
    expect(await state.storage.getAlarm()).toBe(deadline);
    await store.acknowledgeUsage(first.request_id);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

test("session cleanup retains usage recovery while acknowledgements retain the first-frame timeout", async () => {
  await runInDurableObject(proxy(), async (_instance, state) => {
    const now = Date.now();
    const store = new WebSocketStorage(state.storage, () => now);
    const session: StoredWebSocketSession = {
      version: 1,
      phase: "awaiting_first_frame",
      request_id: "session-alarm",
      started_at: now,
      first_frame_deadline: now + 1_000,
      incoming_search: "",
      forwarded_headers: [],
      client_api_key_digest: "test-digest",
      active_response: false,
      response_outcome_recorded: false,
    };
    expect(await store.createSession(session)).toBe(true);
    expect(await store.createSession(session)).toBe(false);
    const event = usage("shared-alarm", now);
    await store.finish(event);
    await store.acknowledgeUsage(event.request_id);
    expect(await state.storage.getAlarm()).toBe(session.first_frame_deadline);
    await store.finish(event);
    await store.clearSession();
    expect(await store.loadSession()).toBeUndefined();
    expect(await state.storage.getAlarm()).not.toBeNull();
    await store.acknowledgeUsage(event.request_id);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

test("recovery preserves completed records and marks unfinished checkpoints incomplete", async () => {
  await runInDurableObject(proxy(), async (_instance, state) => {
    const now = Date.now();
    const store = new WebSocketStorage(state.storage, () => now);
    const completed = usage("completed-checkpoint", now - 2_000);
    const pending = checkpoint(usage("unfinished-checkpoint", now - 2_000));
    await store.checkpoint(completed);
    await store.checkpoint(pending);
    await store.recoverUsage();
    const records = [...(await store.pendingUsage()).values()];
    expect(
      records.find((event) => event.request_id === completed.request_id),
    ).toEqual(completed);
    expect(
      records.find((event) => event.request_id === pending.request_id),
    ).toMatchObject({
      phase: "finished",
      outcome: "incomplete",
      finished_at: now,
      observation_issue: "websocket_instance_restarted",
      billing: { status: "unknown", currency: pending.billing.currency },
    });
    expect((await state.storage.list({ prefix: "usage:" })).size).toBe(0);
    expect(await state.storage.getAlarm()).toBe(now + 10_000);
    for (const event of records) await store.acknowledgeUsage(event.request_id);
  });
});

test("overlapping flushes share one delivery and retain a retry after queue failure", async () => {
  await runInDurableObject(proxy(), async (_instance, state) => {
    const store = new WebSocketStorage(state.storage);
    const event = usage("serialized-delivery", Date.now());
    await store.finish(event);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async (): Promise<void> => {
      await gate;
      throw new Error("queue unavailable");
    });
    const journal = new WebSocketUsage(store, { send }, state);
    const first = journal.flush();
    const second = journal.flush();
    expect(first).toBe(second);
    await expect.poll(() => send.mock.calls.length).toBe(1);
    release();
    await first;
    expect([...(await store.pendingUsage()).values()]).toEqual([event]);
    expect(await state.storage.getAlarm()).not.toBeNull();
    send.mockImplementation(async () => {});
    await journal.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await store.pendingUsage()).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
