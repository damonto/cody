import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesWebSocketProxyCore } from "../src/gateway/websocket/responses-websocket-proxy.ts";
import { SessionPhase } from "../src/gateway/websocket/values.ts";
import {
  AlarmState,
  BackedObjectStorage,
  MemoryObjectBackend,
} from "../src/platform/standard/objects.ts";

async function fixture() {
  const backend = new MemoryObjectBackend();
  const storage = new BackedObjectStorage(
    backend,
    "websocket",
    "client",
    new AlarmState(backend, "websocket", "client"),
  );
  await storage.put("session", {
    version: 2,
    phase: SessionPhase.Open,
    request_id: "connection",
    started_at: Date.now(),
    active_response: false,
    response_outcome_recorded: false,
  });
  const closes = [];
  const client = {
    readyState: 1,
    deserializeAttachment: () => ({ role: "client" }),
    close(code) {
      closes.push(code);
      this.readyState = 3;
    },
  };
  const tasks = [];
  const core = new ResponsesWebSocketProxyCore(
    {
      storage,
      getWebSockets: () => [client],
      waitUntil: (task) => tasks.push(task),
    },
    { LOG_LEVEL: "off" },
  );
  return { core, storage, client, closes, tasks };
}

test("closing a client drops queued messages without waiting for the active read", async (t) => {
  const f = await fixture();
  const blocked = Promise.withResolvers();
  const get = f.storage.get.bind(f.storage);
  const reads = t.mock.method(f.storage, "get", async (...args) => {
    await blocked.promise;
    return get(...args);
  });
  try {
    for (let i = 0; i < 10; i++)
      f.core.webSocketMessage(f.client, new ArrayBuffer(1));
    assert.equal(f.tasks.length, 1, "one drain owns all queued messages");
    await f.core.webSocketClose(f.client, 1000, "client left", true);
    f.core.webSocketMessage(f.client, new ArrayBuffer(1));
    assert.deepEqual(f.closes, [1000]);
  } finally {
    blocked.resolve();
    await Promise.all(f.tasks);
  }
  assert.equal(
    reads.mock.callCount(),
    1,
    "discarded frames never read storage",
  );
});

test("a client processing failure discards queued and subsequent messages", async (t) => {
  const f = await fixture();
  const blocked = Promise.withResolvers();
  const reads = t.mock.method(f.storage, "get", async () => {
    await blocked.promise;
    throw new Error("fixture read failure");
  });
  for (let i = 0; i < 10; i++)
    f.core.webSocketMessage(f.client, new ArrayBuffer(1));
  blocked.resolve();
  await Promise.all(f.tasks);
  f.core.webSocketMessage(f.client, new ArrayBuffer(1));
  await Promise.all(f.tasks);
  assert.equal(reads.mock.callCount(), 1);
  assert.deepEqual(f.closes, [1011]);
});
