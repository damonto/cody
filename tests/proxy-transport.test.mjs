import assert from "node:assert/strict";
import test from "node:test";
import { createUpstreamTransport } from "../src/gateway/transport/index.ts";
import { fetchWithConfiguredRetries } from "../src/gateway/http/proxy.ts";
import { chooseProxy } from "../src/gateway/proxies/policy.ts";
import {
  SocksProxyError,
  ProxyUnavailableError,
} from "../src/gateway/proxies/errors.ts";
import { memoryProxy } from "./helpers/memory-socks.mjs";
import { tlsProxyFixture } from "./helpers/socks-fixture.mjs";
import { RequestLogContext } from "../src/shared/log.ts";

const ok = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
const bad = () => memoryProxy("", { handshake: Buffer.from([5, 255]) });

function transportFixture(request, socks, nodes) {
  const group = {
    id: "US",
    strategy: "priority",
    proxies:
      nodes ??
      ["a", "b", "c"].map((id, index) => ({
        id,
        url: `socks5://${id}.test:1080`,
        priority: 100 - index,
        disabled: false,
      })),
  };
  const observations = [];
  const selections = [];
  const pending = [];
  const generation = crypto.randomUUID();
  const stub = {
    async select(input) {
      selections.push(input);
      const candidate = chooseProxy(
        input.group.proxies.filter(
          (node) => !node.disabled && !input.exclude.includes(node.id),
        ),
        input.group.strategy,
      );
      return candidate
        ? { status: "selected", lease: { proxy_id: candidate.id, generation } }
        : { status: "unavailable" };
    },
    async observe(value) {
      observations.push(value);
    },
  };
  const runtime = {
    config: { proxy_groups: [group] },
    env: { PROXY_GROUP: { getByName: () => stub } },
    clientSignal: request.signal,
    socks,
    context: { waitUntil: (promise) => pending.push(promise) },
  };
  return {
    transport: createUpstreamTransport(
      { id: "provider", proxy_group: "US" },
      { id: "credential" },
      runtime,
    ),
    observations,
    selections,
    pending,
    group,
    stub,
    runtime,
  };
}

test("a proxy handshake failure switches once before HTTP and preserves request bytes and identity", async () => {
  const first = bad();
  const second = memoryProxy(ok);
  const dialed = [];
  const request = new Request("http://upstream.test/responses?x=1&x=2", {
    method: "POST",
    headers: { authorization: "Bearer selected", "x-app": "preserved" },
    body: '{"input":"once"}',
  });
  const f = transportFixture(request, {
    dial: async (address) => {
      dialed.push(address.hostname);
      return address.hostname === "a.test" ? first.socket : second.socket;
    },
  });
  const response = await f.transport.send(request);
  assert.equal(await response.text(), "ok");
  await Promise.all(f.pending);
  assert.deepEqual(dialed, ["a.test", "b.test"]);
  assert.equal(
    first.writes.length,
    1,
    "the failed connection wrote only the SOCKS greeting",
  );
  const forwarded = Buffer.concat(second.writes).toString();
  assert.match(forwarded, /POST \/responses\?x=1&x=2 HTTP\/1.1/);
  assert.match(forwarded, /authorization: Bearer selected/);
  assert.match(forwarded, /x-app: preserved/);
  assert.match(forwarded, /\{"input":"once"\}/);
  assert.deepEqual(
    f.selections.map((selection) => selection.owner),
    [{ provider_id: "provider" }, { provider_id: "provider" }],
  );
  assert.deepEqual(
    f.observations.map((event) => [event.lease.proxy_id, event.outcome]),
    [
      ["a", "failure"],
      ["b", "success"],
    ],
  );
});

test("HTTP status retries share one proxy switch budget and keep the replacement node", async () => {
  const request = new Request("http://upstream.test/responses", {
    method: "POST",
    body: "body",
  });
  const dialed = [];
  let bCalls = 0;
  const f = transportFixture(request, {
    dial: async (address) => {
      dialed.push(address.hostname);
      if (address.hostname === "b.test" && bCalls++ === 0)
        return memoryProxy("HTTP/1.1 503 Busy\r\nContent-Length: 0\r\n\r\n")
          .socket;
      return bad().socket;
    },
  });
  const result = await fetchWithConfiguredRetries(
    () => new Request(request.url, { method: "POST", body: "body" }),
    { status_codes: [503], delays_ms: [0, 0] },
    { send: f.transport.send },
  );
  await Promise.all(f.pending);
  assert.deepEqual(dialed, ["a.test", "b.test", "b.test"]);
  assert.equal(f.selections.length, 2);
  assert.equal(
    result.attempts.length,
    2,
    "TCP attempts do not become separate upstream attempts",
  );
  assert.ok(result.error instanceof SocksProxyError);
  assert.equal(result.response, undefined);
});

test("a valid CONNECT refusal may switch before HTTP without cooling the proxy", async () => {
  const refused = memoryProxy("", {
    handshake: Buffer.from([5, 0, 5, 5, 0, 1, 0, 0, 0, 0, 0, 0]),
  });
  const request = new Request("http://upstream.test/");
  const f = transportFixture(request, {
    dial: async ({ hostname }) =>
      hostname === "a.test" ? refused.socket : memoryProxy(ok).socket,
  });
  assert.equal(await (await f.transport.send(request)).text(), "ok");
  await Promise.all(f.pending);
  assert.equal(
    f.observations.filter((event) => event.outcome === "failure").length,
    0,
  );
  assert.equal(refused.writes.length, 2);
});

test("failures after HTTP begins and truncated streaming responses never select another proxy", async () => {
  for (const response of [
    "INVALID HTTP\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 999\r\n\r\ndata: first\n\n",
  ]) {
    const socket = memoryProxy(response);
    const request = new Request("http://upstream.test/responses", {
      method: "POST",
      body: "write-once",
    });
    let calls = 0;
    const f = transportFixture(request, {
      dial: async () => {
        calls++;
        return socket.socket;
      },
    });
    await assert.rejects(async () => (await f.transport.send(request)).text());
    await Promise.all(f.pending);
    assert.equal(calls, 1);
    assert.equal(
      f.observations.filter((event) => event.outcome === "failure").length,
      0,
    );
    assert.match(
      Buffer.concat(socket.writes).toString(),
      /POST \/responses HTTP\/1.1/,
    );
  }
});

test("a SOCKS socket error after starting HTTP cannot trigger a proxy retry", async () => {
  const socket = memoryProxy(ok);
  let headersWritten = false;
  socket.socket.writable = new WritableStream({
    write(bytes) {
      if (Buffer.from(bytes).toString().startsWith("GET ")) {
        headersWritten = true;
        throw new SocksProxyError("SOCKS5 connection is closed");
      }
    },
  });
  const request = new Request("http://upstream.test/");
  const f = transportFixture(request, { dial: socket.dial });
  await assert.rejects(f.transport.send(request), (error) => {
    assert.equal(f.transport.proxyFailure(error), undefined);
    return /Upstream connection failed/.test(error.message);
  });
  await Promise.all(f.pending);
  assert.equal(headersWritten, true);
  assert.equal(f.selections.length, 1);
  assert.deepEqual(
    f.observations.map((event) => event.outcome),
    ["success"],
  );
});

test("client cancellation never affects proxy health; setup deadlines do and never renew on fallback", async () => {
  const controller = new AbortController();
  const request = new Request("http://upstream.test/", {
    signal: controller.signal,
  });
  const stalled = memoryProxy("", { stall: true });
  const f = transportFixture(request, { dial: stalled.dial });
  const pending = f.transport.send(request);
  const rejected = assert.rejects(pending);
  while (!stalled.writes.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await rejected;
  await Promise.all(f.pending);
  assert.equal(f.observations.length, 0);
  assert.equal(f.selections.length, 1);

  const timed = new Request("http://upstream.test/");
  const sockets = [];
  const g = transportFixture(timed, {
    connectTimeoutMs: 50,
    dial: async ({ hostname }) => {
      if (hostname === "a.test") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const fixture = bad();
        sockets.push(fixture);
        return fixture.socket;
      }
      const fixture = memoryProxy("", { stall: true });
      sockets.push(fixture);
      return fixture.socket;
    },
  });
  const started = performance.now();
  await assert.rejects(g.transport.send(timed), /timed out/);
  await Promise.all(g.pending);
  assert.ok(performance.now() - started < 120);
  assert.equal(g.selections.length, 2);
  assert.equal(
    g.observations.filter((event) => event.outcome === "failure").length,
    2,
  );
  assert.ok(sockets.every((socket) => socket.closes > 0));
});

test("unavailable groups and failed health writes fail closed without direct fetch", async () => {
  const request = new Request("http://upstream.test/");
  const empty = transportFixture(request, {}, []);
  await assert.rejects(
    empty.transport.send(request),
    (error) =>
      error instanceof ProxyUnavailableError &&
      error.code === "proxy_group_unavailable",
  );
  const f = transportFixture(new Request(request.url), {
    dial: async () => bad().socket,
  });
  f.stub.observe = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(
    f.transport.send(new Request(request.url)),
    (error) =>
      error instanceof ProxyUnavailableError &&
      error.code === "proxy_state_unavailable",
  );
  assert.equal(f.selections.length, 1);
});

test("a deadline while confirming proxy health returns a state error before selecting an alternate", async () => {
  const request = new Request("http://upstream.test/");
  const f = transportFixture(request, {
    connectTimeoutMs: 100,
    dial: async () => bad().socket,
  });
  let release;
  f.stub.observe = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  try {
    await assert.rejects(f.transport.send(request), (error) => {
      assert.equal(f.transport.proxyFailure(error)?.status, 503);
      return (
        error instanceof ProxyUnavailableError &&
        error.code === "proxy_state_unavailable"
      );
    });
    assert.equal(f.selections.length, 1);
  } finally {
    release?.();
    await Promise.all(f.pending);
  }
});

test("parallel catalog transports retain every provider's connection diagnostics", async (t) => {
  const entries = [];
  t.mock.method(console, "info", (entry) => entries.push(entry));
  const request = new Request("http://upstream.test/models");
  const requestLog = new RequestLogContext("catalog", request);
  const fixtures = ["first", "second"].map((providerId) => {
    const fixture = transportFixture(request, {
      dial: async ({ hostname }) =>
        hostname === "a.test" ? bad().socket : memoryProxy(ok).socket,
    });
    return {
      ...fixture,
      transport: createUpstreamTransport(
        { id: providerId, proxy_group: "US" },
        { id: "credential" },
        { ...fixture.runtime, requestLog },
      ),
    };
  });
  await Promise.all(
    fixtures.map(async (fixture) => {
      const response = await fixture.transport.send(new Request(request.url));
      assert.equal(await response.text(), "ok");
      await Promise.all(fixture.pending);
    }),
  );
  requestLog.complete(new Response("ok"));
  const summary = entries.find((entry) => entry.event === "request.summary");
  assert.equal(summary.proxy_connections.length, 4);
  for (const providerId of ["first", "second"]) {
    assert.deepEqual(
      summary.proxy_connections
        .filter((entry) => entry.provider_id === providerId)
        .map((entry) => [entry.proxy_id, entry.outcome, entry.switch_reason]),
      [
        ["a", "proxy_failure", undefined],
        ["b", "connected", "proxy_failure"],
      ],
    );
  }
});

test(
  "TLS certificate errors do not switch proxies or count against proxy health",
  { timeout: 10_000 },
  async () => {
    let requests = 0;
    const fixture = await tlsProxyFixture((_request, response) => {
      requests++;
      response.end("unexpected");
    });
    try {
      const request = new Request(fixture.url);
      const f = transportFixture(request, { dial: fixture.options.dial }, [
        { id: "a", ...fixture.proxy, priority: 100, disabled: false },
        { id: "b", ...fixture.proxy, priority: 50, disabled: false },
      ]);
      await assert.rejects(f.transport.send(request), /TLS/);
      await Promise.all(f.pending);
      assert.equal(requests, 0);
      assert.equal(fixture.connections, 1);
      assert.deepEqual(
        f.observations.map((event) => event.outcome),
        ["success"],
      );
    } finally {
      await fixture.close();
    }
  },
);
