import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { connectUpstreamWebSocket } from "../src/platform/standard/websocket-bridge.ts";
import { inspectCodexResponse } from "../src/providers/codex/inspect.ts";

async function rejectionServer(t, upgrade) {
  const server = createServer();
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    socket.once("end", () => socket.destroy());
    socket.resume();
    upgrade(request, socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/responses`;
}

test("native WebSocket rejection decoding preserves Codex quota detection and strips hop headers", async (t) => {
  const payload = JSON.stringify({
    error: {
      type: "usage_limit_reached",
      resets_at: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  const compressed = gzipSync(payload);
  const url = await rejectionServer(t, (request, socket) => {
    assert.equal(request.headers["x-client-hop"], undefined);
    assert.equal(request.headers["proxy-authorization"], undefined);
    socket.end(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: ${compressed.length}\r\nDigest: invalid-after-decoding\r\nConnection: close, x-private-hop\r\nX-Private-Hop: remove\r\nProxy-Authenticate: Basic realm=fixture\r\nX-Upstream: preserved\r\n\r\n`,
        ),
        compressed,
      ]),
    );
  });
  const response = await connectUpstreamWebSocket(
    new Request(url, {
      headers: {
        connection: "keep-alive, x-client-hop",
        "x-client-hop": "remove",
        "proxy-authorization": "remove",
      },
    }),
  );
  const inspected = await inspectCodexResponse(response, {
    signal: new AbortController().signal,
  });
  assert.equal(inspected.usageLimit?.code, "usage_limit_reached");
  assert.equal(await inspected.response.text(), payload);
  for (const name of [
    "content-encoding",
    "content-length",
    "digest",
    "connection",
    "x-private-hop",
    "proxy-authenticate",
  ])
    assert.equal(response.headers.get(name), null, name);
  assert.equal(response.headers.get("x-upstream"), "preserved");
});

test(
  "native WebSocket rejections return headers before EOF and cancel the open response",
  { timeout: 2000 },
  async (t) => {
    const closed = Promise.withResolvers();
    const url = await rejectionServer(t, (_request, socket) => {
      socket.once("close", () => closed.resolve());
      socket.write(
        "HTTP/1.1 503 Busy\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n",
      );
    });
    const response = await connectUpstreamWebSocket(new Request(url));
    assert.equal(response.status, 503);
    const reader = response.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "first",
    );
    await reader.cancel();
    await closed.promise;
  },
);

test("native WebSocket rejections preserve bodies beyond the inspection budget", async (t) => {
  const payload = "x".repeat(70 * 1024);
  const url = await rejectionServer(t, (_request, socket) => {
    socket.end(
      `HTTP/1.1 503 Busy\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
    );
  });
  const response = await connectUpstreamWebSocket(new Request(url));
  assert.equal(response.headers.get("content-length"), String(payload.length));
  assert.equal(await response.text(), payload);
});

for (const read of [false, true]) {
  test(
    `native WebSocket rejection cancellation reaches the socket ${read ? "during" : "before"} a body read`,
    { timeout: 2000 },
    async (t) => {
      const closed = Promise.withResolvers();
      const url = await rejectionServer(t, (_request, socket) => {
        socket.once("close", () => closed.resolve());
        socket.write(
          "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 100\r\n\r\n",
        );
      });
      const controller = new AbortController();
      const response = await connectUpstreamWebSocket(
        new Request(url, { signal: controller.signal }),
      );
      const body = read ? response.text() : undefined;
      controller.abort();
      await assert.rejects(body ?? response.text(), { name: "AbortError" });
      await closed.promise;
    },
  );
}

for (const encoding of ["gzip", "unknown"]) {
  test(
    `invalid ${encoding} rejection bodies close an otherwise open handshake response`,
    { timeout: 2000 },
    async (t) => {
      const closed = Promise.withResolvers();
      const url = await rejectionServer(t, (_request, socket) => {
        socket.once("close", () => closed.resolve());
        socket.write(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 429 Too Many Requests\r\nContent-Encoding: ${encoding}\r\nContent-Length: 1000\r\n\r\n`,
            ),
            Buffer.alloc(16, 255),
          ]),
        );
      });
      await assert.rejects(async () => {
        const response = await connectUpstreamWebSocket(new Request(url));
        await response.text();
      });
      await closed.promise;
    },
  );
}
