import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { UpstreamWebSocket } from "../src/gateway/websocket/upstream.ts";

class Socket extends EventTarget {
  readyState = 1;
  closes = [];
  accept() {}
  close(code, reason) {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
  message(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function upstreamFixture(message) {
  const tasks = [];
  const received = [];
  let failures = 0;
  const upstream = new UpstreamWebSocket(
    {},
    { waitUntil: (task) => tasks.push(task) },
    {
      message: async (data) => {
        received.push(data);
        await message?.(data);
      },
      close: async () => received.push("closed"),
      error: async () => received.push("error"),
      failure: async () => {
        failures++;
      },
    },
  );
  const socket = new Socket();
  upstream.attach(socket);
  return {
    upstream,
    socket,
    tasks,
    received,
    get failures() {
      return failures;
    },
  };
}

test("upstream event processing preserves frame order before a normal close", async () => {
  const blocked = Promise.withResolvers();
  const f = upstreamFixture((data) => data === "first" && blocked.promise);
  f.socket.message("first");
  await setImmediate();
  f.socket.message("second");
  f.socket.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  f.socket.message("after-close");
  assert.deepEqual(f.received, ["first"]);
  assert.equal(f.tasks.length, 1);
  blocked.resolve();
  await Promise.all(f.tasks);
  assert.deepEqual(f.received, ["first", "second", "closed"]);
});

test("upstream byte budget includes the active frame and UTF-8 queued bytes", async () => {
  const blocked = Promise.withResolvers();
  const f = upstreamFixture(() => blocked.promise);
  const active = new ArrayBuffer(32 * 1024 * 1024 - 2);
  f.socket.message(active);
  await setImmediate();
  f.socket.message("界");
  f.socket.message("ignored-after-overflow");
  assert.equal(f.socket.closes[0]?.code, 1013);
  assert.equal(f.tasks.length, 1);
  assert.equal(
    f.failures,
    0,
    "failure handling stays ordered after the active frame",
  );
  blocked.resolve();
  await Promise.all(f.tasks);
  assert.deepEqual(f.received, [active]);
  assert.equal(f.failures, 1);
});

test("upstream event count bounds tiny frames and discards queued payloads on overflow", async () => {
  const blocked = Promise.withResolvers();
  const f = upstreamFixture(() => blocked.promise);
  f.socket.message("");
  await setImmediate();
  for (let index = 0; index < 1023; index++) f.socket.message("");
  assert.equal(f.socket.closes.length, 0);
  f.socket.message("");
  assert.equal(f.socket.closes[0]?.code, 1013);
  blocked.resolve();
  await Promise.all(f.tasks);
  assert.deepEqual(f.received, [""]);
  assert.equal(f.failures, 1);
});

for (const action of ["close", "discard", "replace"]) {
  test(`${action} drops pending frames and an old socket cannot enqueue new work`, async () => {
    const blocked = Promise.withResolvers();
    const f = upstreamFixture(
      (data) => data === "old-active" && blocked.promise,
    );
    f.socket.message("old-active");
    await setImmediate();
    f.socket.message("old-queued");
    if (action === "close") f.upstream.close(1000, "done");
    if (action === "discard") f.upstream.discard(f.socket);
    const next = new Socket();
    f.upstream.attach(next);
    assert.equal(f.socket.closes[0]?.code, 1000);
    f.socket.message("old-late");
    next.message("new");
    blocked.resolve();
    await Promise.all(f.tasks);
    assert.deepEqual(f.received, ["old-active", "new"]);
    next.message("later");
    await Promise.all(f.tasks);
    assert.deepEqual(f.received, ["old-active", "new", "later"]);
  });
}

test("an event handler failure closes the socket and drops its pending frames", async () => {
  const blocked = Promise.withResolvers();
  const f = upstreamFixture(async () => {
    await blocked.promise;
    throw new Error("fixture persistence failure");
  });
  f.socket.message("first");
  await setImmediate();
  f.socket.message("discarded");
  blocked.resolve();
  await Promise.all(f.tasks);
  assert.equal(f.socket.closes[0]?.code, 1011);
  assert.deepEqual(f.received, ["first"]);
  assert.equal(f.failures, 1);
});

test("a failed socket acceptance releases the replacement and its listeners", async () => {
  const f = upstreamFixture();
  const replacement = new Socket();
  replacement.accept = () => {
    throw new Error("acceptance failed");
  };
  assert.throws(() => f.upstream.attach(replacement), /acceptance failed/);
  assert.equal(f.socket.closes[0]?.code, 1000);
  assert.equal(replacement.closes[0]?.code, 1011);
  assert.equal(f.upstream.socket, undefined);
  replacement.message("discarded");
  const next = new Socket();
  f.upstream.attach(next);
  next.message("accepted");
  await Promise.all(f.tasks);
  assert.deepEqual(f.received, ["accepted"]);
});

test("a normal close drains a full message queue without turning it into overflow", async () => {
  const blocked = Promise.withResolvers();
  const f = upstreamFixture(() => blocked.promise);
  f.socket.message("");
  await setImmediate();
  for (let index = 0; index < 1023; index++) f.socket.message("");
  f.socket.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  blocked.resolve();
  await Promise.all(f.tasks);
  assert.equal(f.received.length, 1025);
  assert.equal(f.received.at(-1), "closed");
  assert.equal(f.socket.closes.length, 0);
  assert.equal(f.failures, 0);
});
