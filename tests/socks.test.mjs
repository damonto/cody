import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import {
  socksFetch,
  effectiveProxy,
  createUpstreamFetch,
} from "../src/gateway/transport/index.ts";
import { fetchWithConfiguredRetries } from "../src/gateway/http/proxy.ts";
import { openSocksTunnel } from "../src/gateway/transport/socks.ts";
import { tlsProxyFixture } from "./helpers/socks-fixture.mjs";

const proxy = { url: "socks5://proxy.example:1080" };
const reply = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

function memoryProxy(
  response,
  {
    authenticated = false,
    fragmented = true,
    handshake,
    stall = false,
    keepOpen = false,
    closeGate,
  } = {},
) {
  const data = Buffer.concat([
    handshake ??
      Buffer.concat([
        Buffer.from([5, authenticated ? 2 : 0]),
        ...(authenticated ? [Buffer.from([1, 0])] : []),
        reply,
      ]),
    Buffer.from(response),
  ]);
  let offset = 0;
  let controller;
  let ended = false;
  let closes = 0;
  const writes = [];
  const endpoints = [];
  const closing = Promise.withResolvers();
  const readable = new ReadableStream(
    {
      start(value) {
        controller = value;
      },
      pull(value) {
        if (stall) return;
        if (offset === data.length) {
          if (keepOpen) return;
          ended = true;
          value.close();
          return;
        }
        const next = fragmented ? offset + 1 : data.length;
        value.enqueue(data.subarray(offset, next));
        offset = next;
      },
      cancel() {
        ended = true;
      },
    },
    { highWaterMark: 0 },
  );
  const socket = {
    readable,
    writable: new WritableStream({
      write(chunk) {
        writes.push(Buffer.from(chunk));
      },
    }),
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    close: async () => {
      closes += 1;
      closing.resolve();
      if (!ended) {
        ended = true;
        controller.close();
      }
      await closeGate;
    },
  };
  return {
    writes,
    endpoints,
    socket,
    closing: closing.promise,
    get closes() {
      return closes;
    },
    get consumed() {
      return offset;
    },
    dial: async (address) => {
      endpoints.push(address);
      return socket;
    },
  };
}

test("key proxies replace provider proxies; null explicitly selects direct access", async () => {
  const override = { url: "socks5://key.example:1081" };
  assert.equal(effectiveProxy({ proxy }, {}), proxy);
  assert.equal(effectiveProxy({ proxy }, { proxy: override }), override);
  assert.equal(effectiveProxy({ proxy }, { proxy: null }), undefined);
  assert.equal(effectiveProxy({}, {}), undefined);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("direct");
  };
  try {
    assert.equal(
      await (
        await createUpstreamFetch(
          { proxy },
          { proxy: null },
        )(new Request("https://example.test"))
      ).text(),
      "direct",
    );
    await assert.rejects(
      createUpstreamFetch({ proxy }, {})(new Request("https://example.test")),
      /SOCKS5/,
    );
    assert.equal(
      calls,
      1,
      "a proxy connection failure must not fall back to fetch",
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("SOCKS5 authentication and CONNECT tolerate fragmentation and use remote DNS", async () => {
  const fixture = memoryProxy(
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    { authenticated: true },
  );
  const credentials = { ...proxy, username: "用户", password: "密码" };
  const response = await socksFetch(
    new Request("http://upstream.test/v1/models?x=1&x=2", {
      headers: {
        authorization: "Bearer selected-key",
        "proxy-authorization": "should-be-stripped",
        "x-application": "preserved",
      },
    }),
    credentials,
    fixture,
  );
  assert.equal(await response.text(), "ok");
  assert.deepEqual([...fixture.writes[0]], [5, 1, 2]);
  assert.deepEqual(
    fixture.writes[1],
    Buffer.concat([
      Buffer.from([1, 6]),
      Buffer.from("用户"),
      Buffer.from([6]),
      Buffer.from("密码"),
    ]),
  );
  assert.deepEqual(
    fixture.writes[2],
    Buffer.concat([
      Buffer.from([5, 1, 0, 3, 13]),
      Buffer.from("upstream.test"),
      Buffer.from([0, 80]),
    ]),
  );
  assert.deepEqual(fixture.endpoints, [
    { hostname: "proxy.example", port: 1080 },
  ]);
  const request = fixture.writes[3].toString();
  assert.match(request, /^GET \/v1\/models\?x=1&x=2 HTTP\/1.1\r\n/);
  assert.match(request, /authorization: Bearer selected-key\r\n/);
  assert.match(request, /x-application: preserved\r\n/);
  assert.doesNotMatch(request, /proxy-authorization|用户|密码/);
  assert.equal(fixture.closes, 1);
});

test("coalesced SOCKS replies preserve HTTP bytes and IPv6 CONNECT uses ATYP 4", async () => {
  const fixture = memoryProxy(
    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody",
    { fragmented: false },
  );
  const response = await socksFetch(
    new Request("http://[2001:db8::1]:8080/path"),
    proxy,
    fixture,
  );
  assert.equal(await response.text(), "body");
  assert.deepEqual(
    [...fixture.writes[1].subarray(0, 8)],
    [5, 1, 0, 4, 32, 1, 13, 184],
  );
  assert.deepEqual([...fixture.writes[1].subarray(-2)], [31, 144]);
});

for (const [encoding, compress] of Object.entries({
  gzip: gzipSync,
  deflate: deflateSync,
  br: brotliCompressSync,
})) {
  test(`SOCKS5 decodes fragmented chunked ${encoding} without buffering the complete response`, async () => {
    const payload = 'data: {"delta":"你好"}\n\ndata: [DONE]\n\n';
    const compressed = compress(Buffer.from(payload));
    const chunks = [compressed.subarray(0, 3), compressed.subarray(3)];
    const fixture = memoryProxy(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 103 Early Hints\r\nLink: </warm>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nContent-Encoding: ${encoding}\r\nConnection: close, x-hop\r\nx-hop: remove\r\nx-upstream: keep\r\n\r\n`,
        ),
        ...chunks.flatMap((part) => [
          Buffer.from(`${part.length.toString(16)};fixture=yes\r\n`),
          part,
          Buffer.from("\r\n"),
        ]),
        Buffer.from("0\r\nx-trailer: discarded\r\n\r\n"),
      ]),
    );
    const response = await socksFetch(
      new Request("http://upstream.test/stream"),
      proxy,
      fixture,
    );
    assert.equal(await response.text(), payload);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("transfer-encoding"), null);
    assert.equal(response.headers.get("x-hop"), null);
    assert.equal(response.headers.get("x-upstream"), "keep");
    assert.equal(fixture.closes, 1);
  });
}

for (const status of [302, 403, 429, 503]) {
  test(`SOCKS5 preserves upstream ${status} and its body without redirects or implicit retries`, async () => {
    const fixture = memoryProxy(
      `HTTP/1.1 ${status} Upstream\r\nLocation: https://redirect.test/\r\nContent-Length: 5\r\n\r\nerror`,
    );
    const response = await socksFetch(
      new Request("http://upstream.test/"),
      proxy,
      fixture,
    );
    assert.equal(response.status, status);
    assert.equal(await response.text(), "error");
    assert.equal(response.headers.get("location"), "https://redirect.test/");
    assert.equal(fixture.endpoints.length, 1);
  });
}

test("SOCKS5 HTTP rejects ambiguous framing, truncated bodies and malformed chunks", async () => {
  for (const headers of [
    "Content-Length: 2\r\nContent-Length: 3",
    "Content-Length: 1\r\nTransfer-Encoding: chunked",
    "Transfer-Encoding: gzip, chunked",
  ]) {
    const fixture = memoryProxy(`HTTP/1.1 200 OK\r\n${headers}\r\n\r\na`);
    await assert.rejects(
      socksFetch(new Request("http://upstream.test/"), proxy, fixture),
      /Invalid upstream HTTP/,
    );
    assert.equal(fixture.closes, 1);
  }
  for (const body of [
    "2\r\na",
    "garbage\r\n",
    "1\r\naXX0\r\n\r\n",
    "1;invalid=\0\r\na\r\n0\r\n\r\n",
    "1;invalid=\x7f\r\na\r\n0\r\n\r\n",
  ]) {
    const fixture = memoryProxy(
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`,
    );
    const response = await socksFetch(
      new Request("http://upstream.test/"),
      proxy,
      fixture,
    );
    await assert.rejects(response.text());
    assert.equal(fixture.closes, 1);
  }
  const fixture = memoryProxy(
    "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort",
  );
  await assert.rejects(
    (
      await socksFetch(new Request("http://upstream.test/"), proxy, fixture)
    ).text(),
    /Truncated/,
  );
});

test("timeouts, aborts and response cancellation close the SOCKS socket", async () => {
  const stalled = memoryProxy("", { stall: true });
  await assert.rejects(
    socksFetch(new Request("http://upstream.test/"), proxy, {
      ...stalled,
      connectTimeoutMs: 20,
    }),
    /timed out/,
  );
  assert.equal(stalled.closes, 1);
  const fixture = memoryProxy(
    "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nbody",
  );
  const controller = new AbortController();
  const response = await socksFetch(
    new Request("http://upstream.test/", { signal: controller.signal }),
    proxy,
    fixture,
  );
  controller.abort();
  await assert.rejects(response.text(), { name: "AbortError" });
  assert.equal(fixture.closes, 1);
  const cancelled = memoryProxy(
    "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nbody",
  );
  await (
    await socksFetch(new Request("http://upstream.test/"), proxy, cancelled)
  ).body.cancel();
  assert.equal(cancelled.closes, 1);
});

test(
  "response completion awaits socket teardown and releases both stream locks",
  { timeout: 1000 },
  async () => {
    const teardown = Promise.withResolvers();
    const fixture = memoryProxy(
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
      {
        closeGate: teardown.promise,
      },
    );
    const controller = new AbortController();
    const response = await socksFetch(
      new Request("http://upstream.test/", { signal: controller.signal }),
      proxy,
      fixture,
    );
    let completed = false;
    const body = response.text().then((text) => {
      completed = true;
      return text;
    });
    try {
      await fixture.closing;
      controller.abort();
      assert.equal(completed, false);
      assert.equal(fixture.closes, 1);
    } finally {
      teardown.resolve();
    }
    assert.equal(await body, "");
    assert.equal(fixture.socket.readable.locked, false);
    assert.equal(fixture.socket.writable.locked, false);
  },
);

test(
  "a socket that arrives after dial cancellation is closed without starting SOCKS authentication",
  { timeout: 1000 },
  async () => {
    const dialing = Promise.withResolvers();
    const controller = new AbortController();
    const operation = openSocksTunnel(
      proxy,
      { hostname: "upstream.test", port: 443 },
      controller.signal,
      () => dialing.promise,
    );
    const rejected = assert.rejects(operation, { name: "AbortError" });
    controller.abort();
    await rejected;
    const fixture = memoryProxy("", { stall: true });
    dialing.resolve(fixture.socket);
    await fixture.closing;
    assert.equal(fixture.closes, 1);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.socket.readable.locked, false);
    assert.equal(fixture.socket.writable.locked, false);
  },
);

test(
  "cancelling a pending body read closes the tunnel without enqueueing after cancellation",
  { timeout: 1000 },
  async () => {
    const fixture = memoryProxy(
      "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n",
      {
        keepOpen: true,
      },
    );
    const response = await socksFetch(
      new Request("http://upstream.test/"),
      proxy,
      fixture,
    );
    const reader = response.body.getReader();
    const pending = reader.read();
    await reader.cancel();
    assert.deepEqual(await pending, { value: undefined, done: true });
    assert.equal(fixture.closes, 1);
    assert.equal(fixture.socket.readable.locked, false);
    assert.equal(fixture.socket.writable.locked, false);
  },
);

test(
  "invalid content encoding lists release the source before any decoder can lock it",
  { timeout: 1000 },
  async () => {
    for (const encoding of [
      "br, unknown",
      "unknown, br",
      "gzip, gzip, gzip, gzip, gzip",
    ]) {
      const fixture = memoryProxy(
        `HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: 1000\r\n\r\n`,
        { keepOpen: true },
      );
      await assert.rejects(
        socksFetch(new Request("http://upstream.test/"), proxy, fixture),
        /Unsupported upstream HTTP content encoding/,
      );
      assert.equal(fixture.closes, 1);
      assert.equal(fixture.socket.readable.locked, false);
      assert.equal(fixture.socket.writable.locked, false);
    }
  },
);

test(
  "a Brotli decoding failure cancels an otherwise open upstream body",
  { timeout: 1000 },
  async () => {
    const fixture = memoryProxy(
      Buffer.concat([
        Buffer.from(
          "HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: 1000\r\n\r\n",
        ),
        Buffer.from([255, 255, 255, 255]),
      ]),
      { keepOpen: true },
    );
    const response = await socksFetch(
      new Request("http://upstream.test/"),
      proxy,
      fixture,
    );
    await assert.rejects(response.text());
    await fixture.closing;
    assert.equal(fixture.closes, 1);
  },
);

test(
  "cancelling a Brotli response propagates to the active SOCKS connection",
  { timeout: 1000 },
  async () => {
    const fixture = memoryProxy(
      "HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: 1000\r\n\r\n",
      { keepOpen: true },
    );
    const response = await socksFetch(
      new Request("http://upstream.test/"),
      proxy,
      fixture,
    );
    await response.body.cancel();
    await fixture.closing;
    assert.equal(fixture.closes, 1);
  },
);

test("authentication rejection is not downgraded or retried", async () => {
  for (const handshake of [
    Buffer.from([5, 0]),
    Buffer.from([5, 2, 1, 1]),
    Buffer.from([5, 255]),
  ]) {
    const fixture = memoryProxy("", { handshake });
    await assert.rejects(
      socksFetch(
        new Request("http://upstream.test/"),
        { ...proxy, username: "user", password: "hidden-password" },
        fixture,
      ),
      /SOCKS5/,
    );
    assert.equal(fixture.endpoints.length, 1);
    assert.equal(fixture.closes, 1);
  }
});

test("only the provider's configured HTTP retry policy opens another SOCKS connection", async () => {
  const fixtures = [];
  const result = await fetchWithConfiguredRetries(
    () =>
      new Request("http://upstream.test/", {
        headers: { authorization: "Bearer same-key" },
      }),
    { status_codes: [429], delays_ms: [0] },
    {
      send: (request) => {
        const status = fixtures.length ? 200 : 429;
        const fixture = memoryProxy(
          `HTTP/1.1 ${status} Upstream\r\nContent-Length: 2\r\n\r\nok`,
        );
        fixtures.push(fixture);
        return socksFetch(request, proxy, fixture);
      },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), "ok");
  assert.equal(fixtures.length, 2);
  assert.ok(
    fixtures.every((fixture) =>
      fixture.writes.at(-1).toString().includes("Bearer same-key"),
    ),
  );
});

for (const tlsVersion of ["TLSv1.2", "TLSv1.3"]) {
  test(
    `SOCKS5 tunnels ${tlsVersion}, verifies the origin certificate and preserves request bytes`,
    { timeout: 10_000 },
    async (t) => {
      const received = [];
      const fixture = await tlsProxyFixture(
        (request, response) => {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => {
            received.push({
              url: request.url,
              headers: request.headers,
              body: Buffer.concat(chunks),
            });
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ok":true}');
          });
        },
        {
          tlsVersion,
          credentials: { username: "user", password: "proxy-password" },
        },
      );
      t.after(() => fixture.close());
      const payload = Buffer.from(
        JSON.stringify({ model: "test", input: "你好".repeat(20_000) }),
      );
      const result = await socksFetch(
        new Request(`${fixture.url}/v1/responses?x=1&x=2`, {
          method: "POST",
          body: payload,
          headers: { authorization: "Bearer upstream-key" },
        }),
        fixture.proxy,
        fixture.options,
      );
      assert.deepEqual(await result.json(), { ok: true });
      assert.deepEqual(received[0].body, payload);
      assert.equal(received[0].url, "/v1/responses?x=1&x=2");
      assert.equal(received[0].headers.authorization, "Bearer upstream-key");
      assert.equal(received[0].headers["proxy-authorization"], undefined);
      assert.equal(fixture.destinations[0].host, "upstream.test");
      assert.equal(fixture.destinations[0].type, 3);
      assert.equal(fixture.connections, 1);
    },
  );
}

test(
  "TLS rejects untrusted and wrong-host certificates before sending HTTP credentials",
  { timeout: 10_000 },
  async (t) => {
    let requests = 0;
    const fixture = await tlsProxyFixture((_request, response) => {
      requests += 1;
      response.end("unsafe");
    });
    t.after(() => fixture.close());
    await assert.rejects(
      socksFetch(new Request(fixture.url), fixture.proxy, {
        ...fixture.options,
        trustedCertificates: [],
      }),
      /TLS/,
    );
    await assert.rejects(
      socksFetch(
        new Request(fixture.url.replace("upstream.test", "wrong.test")),
        fixture.proxy,
        fixture.options,
      ),
      /TLS/,
    );
    assert.equal(requests, 0);
    assert.equal(fixture.connections, 2);
  },
);

test(
  "TLS SSE delivers the first event before the upstream finishes",
  { timeout: 10_000 },
  async (t) => {
    let finish;
    const fixture = await tlsProxyFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      finish = () => response.end("data: [DONE]\n\n");
    });
    t.after(() => fixture.close());
    const response = await socksFetch(
      new Request(fixture.url),
      fixture.proxy,
      fixture.options,
    );
    const reader = response.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "data: first\n\n",
    );
    finish();
    let tail = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      tail += new TextDecoder().decode(part.value);
    }
    assert.equal(tail, "data: [DONE]\n\n");
  },
);

test(
  "an early TLS HTTP rejection cancels a stalled request upload",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await tlsProxyFixture((_request, response) => {
      response.writeHead(413, { "content-type": "text/plain" });
      response.end("too large");
    });
    t.after(() => fixture.close());
    let cancelled = false;
    const response = await socksFetch(
      new Request(fixture.url, {
        method: "POST",
        duplex: "half",
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      }),
      fixture.proxy,
      fixture.options,
    );
    assert.equal(response.status, 413);
    assert.equal(await response.text(), "too large");
    assert.equal(cancelled, true);
    assert.equal(fixture.connections, 1);
  },
);

test(
  "TLS requires a matching SAN and does not match a wildcard to its bare parent domain",
  { timeout: 10_000 },
  async (t) => {
    for (const options of [
      { sanHostname: "other.test" },
      { hostname: "*.upstream.test" },
    ]) {
      let requests = 0;
      const fixture = await tlsProxyFixture((_request, response) => {
        requests += 1;
        response.end("unsafe");
      }, options);
      t.after(() => fixture.close());
      await assert.rejects(
        socksFetch(new Request(fixture.url), fixture.proxy, fixture.options),
        /certificate validation failed/,
      );
      assert.equal(requests, 0);
      if (options.hostname) {
        const response = await socksFetch(
          new Request(
            fixture.url.replace("upstream.test", "api.upstream.test"),
          ),
          fixture.proxy,
          fixture.options,
        );
        assert.equal(await response.text(), "unsafe");
        assert.equal(requests, 1);
      }
    }
  },
);
