import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { websocketOverConnection } from "../src/gateway/transport/websocket.ts";
import { createUpstreamTransport } from "../src/gateway/transport/index.ts";
import { installWebSocketPair } from "../src/platform/standard/websocket-pair.ts";

installWebSocketPair();

function connectionFixture() {
  const queued = [];
  let pending;
  let closed = false;
  let writeError;
  const writes = [];
  const deliver = (value) => {
    if (pending) {
      pending.resolve(value);
      pending = undefined;
    } else queued.push(value);
  };
  const connection = {
    async read() {
      let value;
      if (queued.length) value = queued.shift();
      else if (closed) value = null;
      else value = await (pending = Promise.withResolvers()).promise;
      if (value instanceof Error) throw value;
      return value;
    },
    async write(data) {
      if (writeError) throw writeError;
      writes.push(Buffer.from(data));
      const key = /sec-websocket-key: ([^\r]+)/i.exec(
        Buffer.from(data).toString(),
      )?.[1];
      if (key) {
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        deliver(
          Buffer.from(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          ),
        );
      }
    },
    async close() {
      closed = true;
      deliver(null);
    },
  };
  return {
    connection,
    deliver,
    writes,
    failWrites(error) {
      writeError = error;
    },
  };
}

async function openFixture(t, onFailure, controller = new AbortController()) {
  const f = connectionFixture();
  const response = await websocketOverConnection(
    new Request("https://upstream.test/responses", {
      headers: { upgrade: "websocket" },
      signal: controller.signal,
    }),
    f.connection,
    onFailure,
  );
  const socket = response.webSocket;
  socket.accept({ allowHalfOpen: true });
  const closing = new Promise((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  t.after(() => f.connection.close());
  return { ...f, socket, closing };
}

for (const kind of ["eof", "read", "write", "protocol", "abort"]) {
  test(
    `SOCKS WebSocket diagnoses ${kind} once while preserving its close behavior`,
    { timeout: 2000 },
    async (t) => {
      const failures = [];
      const controller = new AbortController();
      const f = await openFixture(
        t,
        (entry) => failures.push(entry),
        controller,
      );
      const original = Object.assign(new Error("fixture connection reset"), {
        code: "ECONNRESET",
      });
      if (kind === "eof") f.deliver(null);
      if (kind === "read") f.deliver(original);
      if (kind === "write") {
        f.failWrites(original);
        f.socket.send("private request payload");
      }
      if (kind === "protocol") f.deliver(Buffer.from([0x83, 0]));
      if (kind === "abort") controller.abort(original);
      assert.equal((await f.closing).code, 1011);
      await setImmediate();
      assert.equal(failures.length, 1);
      assert.equal(failures[0].stage, kind === "eof" ? "read" : kind);
      assert.equal(failures[0].phase, "open");
      assert(failures[0].duration_ms >= 0);
      assert.equal(failures[0].received_bytes, kind === "protocol" ? 2 : 0);
      assert.equal(failures[0].sent_bytes, f.writes[0].byteLength);
      if (["read", "write", "abort"].includes(kind))
        assert.equal(failures[0].error, original);
      if (kind === "eof")
        assert.match(
          failures[0].error.message,
          /without a WebSocket close frame/,
        );
      assert.doesNotMatch(JSON.stringify(failures), /private request payload/);
    },
  );
}

test("a remote WebSocket close retains its code/reason without a transport failure", async (t) => {
  const failures = [];
  const f = await openFixture(t, (entry) => failures.push(entry));
  const reason = "upstream internal error";
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(1011);
  payload.write(reason, 2);
  f.deliver(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
  const event = await f.closing;
  assert.equal(event.code, 1011);
  assert.equal(event.reason, reason);
  assert.deepEqual(failures, []);
});

test("diagnostic callback failures cannot prevent socket teardown", async (t) => {
  const f = await openFixture(t, () => {
    throw new Error("logging unavailable");
  });
  f.deliver(null);
  assert.equal((await f.closing).code, 1011);
});

test("a reentrant diagnostic callback cannot report a second failure", async (t) => {
  const failures = [];
  const controller = new AbortController();
  const f = await openFixture(
    t,
    (diagnostic) => {
      failures.push(diagnostic);
      if (failures.length === 1) controller.abort();
    },
    controller,
  );
  f.deliver(new Error("original read failure"));
  assert.equal((await f.closing).code, 1011);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "read");
});

test(
  "proxy WebSocket logs correlate a read failure and redact opaque credentials",
  { timeout: 2000 },
  async (t) => {
    const entries = [];
    t.mock.method(console, "warn", (entry) => entries.push(entry));
    const f = connectionFixture();
    const node = {
      id: "proxy-node",
      url: "socks5://proxy.test:1080",
      username: "private-user",
      password: "opaque-private-password",
      priority: 1,
      disabled: false,
    };
    let socksPhase = 0;
    const socket = {
      opened: Promise.resolve(),
      closed: Promise.resolve(),
      close: f.connection.close,
      readable: new ReadableStream({
        async pull(controller) {
          try {
            const bytes = await f.connection.read();
            if (bytes === null) controller.close();
            else controller.enqueue(bytes);
          } catch (error) {
            controller.error(error);
          }
        },
      }),
      writable: new WritableStream({
        write(data) {
          if (socksPhase++ === 0) f.deliver(Buffer.from([5, 2]));
          else if (socksPhase === 2) f.deliver(Buffer.from([1, 0]));
          else if (socksPhase === 3)
            f.deliver(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          else return f.connection.write(data);
        },
      }),
    };
    const request = new Request("http://upstream.test/responses", {
      headers: {
        upgrade: "websocket",
        "x-api-key": "opaque-upstream-key",
        authorization: "Bearer opaque-bearer-value",
      },
    });
    const transport = createUpstreamTransport(
      { id: "provider", proxy_group: "group" },
      { id: "credential", proxy_group: "group" },
      {
        requestId: "connection-id",
        clientSignal: request.signal,
        config: {
          revision: 1,
          proxy_groups: [
            { id: "group", strategy: "priority", proxies: [node] },
          ],
        },
        env: {
          PROXY_GROUP: {
            getByName: () => ({
              select: async () => ({
                status: "selected",
                lease: { proxy_id: node.id, generation: crypto.randomUUID() },
              }),
              observe: async () => {},
            }),
          },
        },
        socks: { dial: async () => socket },
      },
    );
    const response = await transport.send(request);
    response.webSocket.accept();
    const closing = new Promise((resolve) =>
      response.webSocket.addEventListener("close", resolve, { once: true }),
    );
    const originalPassword = node.password;
    node.password = "replacement-password";
    request.headers.set("x-api-key", "replacement-key");
    request.headers.set("authorization", "Bearer replacement-bearer");
    f.deliver(
      new Error(
        `read ${originalPassword} opaque-upstream-key opaque-bearer-value`,
        {
          cause: Object.assign(new Error("private TLS diagnostic material"), {
            code: "ECONNRESET",
          }),
        },
      ),
    );
    assert.equal((await closing).code, 1011);
    const failure = entries.find(
      (entry) => entry.event === "websocket.transport.failed",
    );
    assert.equal(failure.connection_id, "connection-id");
    assert.equal(failure.provider_id, "provider");
    assert.equal(failure.credential_id, "credential");
    assert.equal(failure.proxy_id, "proxy-node");
    assert.equal(failure.stage, "read");
    assert.equal(failure.transport, "socks5");
    assert.equal(failure.error_causes[0].error_code, "ECONNRESET");
    assert.doesNotMatch(JSON.stringify(entries), /opaque-|private TLS/);
  },
);
