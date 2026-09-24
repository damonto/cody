import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { IoRedisClient } from "../src/platform/standard/ioredis.ts";
import { NodeWebSocketPair } from "../src/platform/standard/websocket-pair.ts";
import { bridgeWebSocket } from "../src/platform/standard/websocket-bridge.ts";
import {
  MAX_WEBSOCKET_BUFFER_BYTES,
  MAX_WEBSOCKET_BUFFER_MESSAGES,
} from "../src/platform/standard/websocket-limits.ts";

test("Redis closes only idle connections, reconnects once and tracks cleanup with waitUntil", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = Promise.withResolvers();
  const tracked = [];
  let opens = 0;
  let disconnects = 0;
  const client = new IoRedisClient(
    async () => {
      opens += 1;
      return {
        ping: async () => "PONG",
        get: (key) =>
          key === "slow" ? pending.promise : Promise.resolve("value"),
        quit: async () => "OK",
        disconnect: () => {
          disconnects += 1;
        },
      };
    },
    { idleTimeoutMs: 100, waitUntil: (task) => tracked.push(task) },
  );
  t.after(() => client.quit());
  await client.connect();
  const slow = client.get("slow");
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(disconnects, 0);
  pending.resolve("finished");
  assert.equal(await slow, "finished");
  t.mock.timers.tick(100);
  await Promise.all(tracked);
  assert.equal(disconnects, 1);
  assert.deepEqual(await Promise.all([client.get("one"), client.get("two")]), [
    "value",
    "value",
  ]);
  assert.equal(opens, 2);
  await client.quit();
  await Promise.all(tracked);
  assert.equal(disconnects, 2);
  await assert.rejects(client.get("closed"), /closed/);
});

test("Redis retries initialization after a failed connection and shuts down failed commands", async () => {
  let attempts = 0;
  let disconnected = false;
  const client = new IoRedisClient(async () => {
    if (++attempts === 1) throw new Error("unavailable");
    return {
      get: async () => {
        throw new Error("command failed");
      },
      quit: async () => "OK",
      disconnect: () => {
        disconnected = true;
      },
    };
  });
  await assert.rejects(client.get("key"), /unavailable/);
  await assert.rejects(client.get("key"), /command failed/);
  await client.quit();
  assert.equal(attempts, 2);
  assert.equal(disconnected, true);
});

test("WebSocket pairs bound both pending acceptance and scheduled event queues", async () => {
  for (const accepted of [false, true]) {
    const [sender, receiver] = Object.values(new NodeWebSocketPair());
    let close;
    let messages = 0;
    sender.accept();
    receiver.addEventListener("close", (event) => {
      close = event.code;
    });
    receiver.addEventListener("message", () => {
      messages += 1;
    });
    if (accepted) receiver.accept();
    for (let i = 0; i <= MAX_WEBSOCKET_BUFFER_MESSAGES; i++) sender.send("");
    receiver.accept();
    await setImmediate();
    assert.equal(sender.readyState, 3);
    assert.equal(receiver.readyState, 3);
    assert.equal(messages, 0);
    assert.equal(close, 1013);
  }
});

test("WebSocket pairs reject oversized UTF-8 messages before queueing them", async () => {
  const [sender, receiver] = Object.values(new NodeWebSocketPair());
  sender.accept();
  let close;
  sender.addEventListener("close", (event) => {
    close = event.code;
  });
  sender.send("界".repeat(Math.floor(MAX_WEBSOCKET_BUFFER_BYTES / 3) + 1));
  receiver.accept();
  await setImmediate();
  assert.equal(close, 1013);
});

test("WebSocket bridge closes a slow consumer before exceeding its send budget", async () => {
  const network = new EventEmitter();
  network.readyState = 1;
  network.bufferedAmount = MAX_WEBSOCKET_BUFFER_BYTES - 2;
  let close;
  network.close = (code) => {
    close = code;
    network.readyState = 2;
  };
  network.send = () => {
    assert.fail("must not enqueue more network data");
  };
  const [gateway, peer] = Object.values(new NodeWebSocketPair());
  gateway.accept();
  bridgeWebSocket(network, peer);
  gateway.send("界");
  await setImmediate();
  assert.equal(close, 1013);
  assert.equal(gateway.readyState, 3);
});
