import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { fetchUpstream } from "../src/platform/standard/http.ts";

async function upstream(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const payload = Buffer.from(
  JSON.stringify({ data: [{ b64_json: "abcd".repeat(20_000) }] }),
);
const digestHeaders = [
  "content-md5",
  "digest",
  "content-digest",
  "repr-digest",
];

for (const [encoding, encode] of [
  ["gzip", gzipSync],
  ["x-gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
  ["zstd", zstdCompressSync],
  ["gzip, br", (bytes) => brotliCompressSync(gzipSync(bytes))],
]) {
  test(`native fetch forwards ${encoding} with matching headers`, async (t) => {
    const wire = encode(payload);
    const url = await upstream(t, (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": encoding,
        "content-length": wire.length,
        ...Object.fromEntries(digestHeaders.map((header) => [header, "stale"])),
        connection: "keep-alive, x-hop",
        "x-hop": "remove",
        "x-upstream": "preserved",
      });
      response.end(wire);
    });
    let decoded = true;
    // Only zstd varies across supported Node 24 releases; other codecs must decode.
    if (encoding === "zstd") {
      const native = await fetch(url);
      decoded = Buffer.from(await native.arrayBuffer()).equals(payload);
    }
    const response = await fetchUpstream(new Request(url));
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      decoded ? payload : wire,
    );
    for (const [header, original] of [
      ["content-encoding", encoding],
      ["content-length", String(wire.length)],
      ...digestHeaders.map((header) => [header, "stale"]),
    ])
      assert.equal(
        response.headers.get(header),
        decoded ? null : original,
        header,
      );
    for (const header of ["connection", "keep-alive", "x-hop"])
      assert.equal(response.headers.get(header), null, header);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("x-upstream"), "preserved");
  });
}

for (const encoding of [undefined, "identity", "custom", "custom, gzip"]) {
  test(`native fetch preserves untouched ${encoding ?? "unencoded"} bytes and metadata`, async (t) => {
    const wire = encoding === "custom, gzip" ? gzipSync(payload) : payload;
    const url = await upstream(t, (_request, response) => {
      response.writeHead(200, {
        ...(encoding ? { "content-encoding": encoding } : {}),
        "content-length": wire.length,
        "content-digest": "preserved",
      });
      response.end(wire);
    });
    const response = await fetchUpstream(new Request(url));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), wire);
    assert.equal(response.headers.get("content-encoding"), encoding ?? null);
    assert.equal(response.headers.get("content-length"), String(wire.length));
    assert.equal(response.headers.get("content-digest"), "preserved");
  });
}

for (const [method, status] of [
  ["HEAD", 200],
  ["GET", 304],
]) {
  test(`native fetch preserves representation metadata for ${method} ${status}`, async (t) => {
    const url = await upstream(t, (_request, response) => {
      response.writeHead(status, {
        "content-encoding": "gzip",
        "content-length": 123,
        "content-digest": "preserved",
      });
      response.end();
    });
    const response = await fetchUpstream(new Request(url, { method }));
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(response.headers.get("content-length"), "123");
    assert.equal(response.headers.get("content-digest"), "preserved");
  });
}

test(
  "native fetch streams decoded bytes and propagates cancellation",
  { timeout: 5000 },
  async (t) => {
    let closed;
    const url = await upstream(t, (_request, response) => {
      closed = once(response, "close");
      response.writeHead(200, { "content-encoding": "gzip" });
      response.write(gzipSync(payload));
      // Keep the response open to verify headers and body delivery do not await EOF.
    });
    const response = await fetchUpstream(new Request(url));
    const reader = response.body.getReader();
    assert.ok((await reader.read()).value.length > 0);
    await reader.cancel();
    reader.releaseLock();
    await closed;
  },
);

for (const status of [307, 429, 503]) {
  test(`native fetch preserves compressed ${status} responses without replay`, async (t) => {
    const requests = [];
    const error = JSON.stringify({ error: { message: "upstream response" } });
    const wire = gzipSync(error);
    const url = await upstream(t, async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        path: request.url,
        method: request.method,
        header: request.headers["x-application"],
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(status, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": wire.length,
        location: "/must-not-follow",
        "retry-after": "60",
      });
      response.end(wire);
    });
    const response = await fetchUpstream(
      new Request(`${url}/images/generations?a=1&a=2`, {
        method: "POST",
        body: '{"model":"image"}',
        headers: { "x-application": "preserved" },
        redirect: "manual",
      }),
    );
    assert.equal(response.status, status);
    assert.equal(await response.text(), error);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("location"), "/must-not-follow");
    assert.equal(response.headers.get("retry-after"), "60");
    assert.deepEqual(requests, [
      {
        path: "/images/generations?a=1&a=2",
        method: "POST",
        header: "preserved",
        body: '{"model":"image"}',
      },
    ]);
  });
}

for (const phase of ["headers", "body"]) {
  test(
    `native fetch propagates request abort while waiting for ${phase}`,
    { timeout: 5000 },
    async (t) => {
      const connected = Promise.withResolvers();
      const closed = Promise.withResolvers();
      const url = await upstream(t, (_request, response) => {
        response.once("close", closed.resolve);
        if (phase === "body") {
          response.writeHead(200, { "content-encoding": "gzip" });
          response.flushHeaders();
        }
        connected.resolve();
      });
      const abort = new AbortController();
      const pending = fetchUpstream(new Request(url, { signal: abort.signal }));
      await connected.promise;
      const response = phase === "body" ? await pending : undefined;
      const rejected = assert.rejects(
        response ? response.text() : pending,
        /cancelled/,
      );
      abort.abort(new Error("client cancelled"));
      await rejected;
      await closed.promise;
    },
  );
}
