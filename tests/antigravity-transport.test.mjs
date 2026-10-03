import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:https";
import { gzipSync } from "node:zlib";
import { certificates, tlsProxyFixture } from "./helpers/socks-fixture.mjs";
import { createAntigravityHttpConnector } from "../src/platform/standard/antigravity-http.ts";
import { createUpstreamTransport } from "../src/gateway/transport/index.ts";
import { prepareProviderRequest } from "../src/providers/index.ts";
import { providerOutbound } from "../src/providers/outbound.ts";
import { providerTransportPolicy } from "../src/providers/transport.ts";

async function serverFor(t, handler, options = {}) {
  const certificate = await certificates("localhost");
  const server = createServer(
    { ...certificate, ALPNProtocols: ["h2", "http/1.1"] },
    handler,
  );
  server.listen(0, "localhost");
  await once(server, "listening");
  const connector = createAntigravityHttpConnector({
    ...options,
    ca: certificate.root,
  });
  t.after(async () => {
    connector.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    server,
    connector,
    url: `https://localhost:${server.address().port}`,
  };
}

test("native Antigravity keeps HTTP/1.1 sockets without ALPN and preserves status and body", async (t) => {
  const received = [];
  const fixture = await serverFor(t, async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    received.push({
      socket: request.socket,
      alpn: request.socket.alpnProtocol,
      version: request.httpVersion,
      headers: request.headers,
      body: Buffer.concat(parts).toString(),
    });
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "60",
      "content-encoding": "gzip",
    });
    response.end(gzipSync('{"error":"quota"}'));
  });
  for (let i = 0; i < 2; i++) {
    const response = await fixture.connector.send(
      new Request(fixture.url, {
        method: "POST",
        body: "hello",
        headers: {
          "content-type": "application/json",
          "user-agent": "antigravity",
          authorization: "Bearer test",
        },
      }),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(await response.text(), '{"error":"quota"}');
  }
  assert.equal(received.length, 2);
  assert.equal(received[0].socket, received[1].socket);
  assert.equal(received[0].alpn, false);
  assert.equal(received[0].version, "1.1");
  assert.equal(received[0].headers.connection, undefined);
  assert.equal(received[0].body, "hello");
});

test(
  "native Antigravity streams immediately and cancellation closes its upstream",
  { timeout: 5000 },
  async (t) => {
    let close;
    const closed = new Promise((resolve) => {
      close = resolve;
    });
    const fixture = await serverFor(t, (request, response) => {
      response.on("close", close);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
    });
    const response = await fixture.connector.send(new Request(fixture.url));
    const reader = response.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "data: first\n\n",
    );
    await reader.cancel();
    await closed;
  },
);

test("native Antigravity validates certificates and never follows redirects", async (t) => {
  let requests = 0;
  const fixture = await serverFor(t, (_request, response) => {
    requests++;
    response.writeHead(302, { location: "/other" });
    response.end("redirect");
  });
  const untrusted = createAntigravityHttpConnector();
  t.after(() => untrusted.close());
  await assert.rejects(
    untrusted.send(new Request(fixture.url)),
    /certificate|issuer/i,
  );
  const response = await fixture.connector.send(new Request(fixture.url));
  assert.equal(response.status, 302);
  assert.equal(await response.text(), "redirect");
  assert.equal(requests, 1);
});

test(
  "an unexpected protocol upgrade rejects instead of leaving a pending fetch",
  { timeout: 5000 },
  async (t) => {
    const fixture = await serverFor(t, (_request, response) => {
      response.writeHead(101, { connection: "upgrade", upgrade: "unexpected" });
      response.end();
    });
    await assert.rejects(
      fixture.connector.send(new Request(fixture.url, { signal: t.signal })),
      /closed before a response/i,
    );
  },
);

test(
  "aborting an active native SSE request rejects a pending body read",
  { timeout: 5000 },
  async (t) => {
    const fixture = await serverFor(t, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
    });
    const abort = new AbortController();
    const response = await fixture.connector.send(
      new Request(fixture.url, { signal: abort.signal }),
    );
    const pending = response.body.getReader().read();
    abort.abort(new Error("client disconnected"));
    await assert.rejects(pending);
  },
);

test("an upstream disconnect before the first body read becomes a stream error", async (t) => {
  let upstream;
  const fixture = await serverFor(t, (_request, response) => {
    upstream = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  const response = await fixture.connector.send(new Request(fixture.url));
  upstream.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(response.text(), /aborted|closed|reset/i);
});

test("SOCKS5 Antigravity omits ALPN while other providers retain their default", async (t) => {
  const protocols = [];
  const fixture = await tlsProxyFixture((request, response) => {
    protocols.push(request.socket.alpnProtocol);
    response.end("ok");
  });
  t.after(() => fixture.close());
  const group = {
    id: crypto.randomUUID(),
    strategy: "priority",
    proxies: [
      {
        id: crypto.randomUUID(),
        ...fixture.proxy,
        priority: 1,
        disabled: false,
      },
    ],
  };
  const env = {
    PROXY_GROUP: {
      getByName: () => ({
        select: async () => ({
          status: "selected",
          lease: {
            proxy_id: group.proxies[0].id,
            generation: crypto.randomUUID(),
          },
        }),
        observe: async () => {},
      }),
    },
    UPSTREAM_HTTP: {
      antigravity: () =>
        assert.fail("proxy requests must not use the direct connector"),
    },
  };
  const context = {
    config: { proxy_groups: [group] },
    env,
    clientSignal: new AbortController().signal,
    socks: { ...fixture.options, omitAlpn: false },
  };
  for (const type of ["ai_gateway", "antigravity", "codex", "claude", "xai"]) {
    const transport = createUpstreamTransport(
      { id: crypto.randomUUID(), proxy_group: group.id },
      { id: crypto.randomUUID() },
      context,
      providerTransportPolicy(type, env),
    );
    const response = await transport.send(new Request(fixture.url));
    assert.equal(await response.text(), "ok");
    assert.equal(
      context.socks.omitAlpn,
      false,
      "provider policy must not mutate shared context",
    );
  }
  assert.deepEqual(protocols, [
    "http/1.1",
    false,
    "http/1.1",
    "http/1.1",
    "http/1.1",
  ]);
});

test(
  "an early quota rejection cancels a stalled upload without losing the response",
  { timeout: 5000 },
  async (t) => {
    let cancelled = false;
    const sockets = [];
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial request"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fixture = await serverFor(t, (request, response) => {
      sockets.push(request.socket);
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":"quota"}');
    });
    const response = await fixture.connector.send(
      new Request(fixture.url, {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-length": "1000" },
      }),
    );
    assert.equal(response.status, 429);
    assert.equal(await response.text(), '{"error":"quota"}');
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    const next = await fixture.connector.send(new Request(fixture.url));
    await next.text();
    assert.notEqual(sockets[0], sockets[1]);
  },
);

test("a closed native connector never reopens a connection", async (t) => {
  let requests = 0;
  const fixture = await serverFor(t, (_request, response) => {
    requests++;
    response.end("ok");
  });
  fixture.connector.close();
  await assert.rejects(
    fixture.connector.send(new Request(fixture.url)),
    /closed/i,
  );
  assert.equal(requests, 0);
});

test(
  "serverless idle cleanup is awaited and releases reused sockets from the old task",
  { timeout: 5000 },
  async (t) => {
    const tasks = [];
    const sockets = [];
    let stream;
    const fixture = await serverFor(
      t,
      (request, response) => {
        sockets.push(request.socket);
        if (request.url === "/stream") {
          stream = response;
          response.write("first");
        } else response.end("ok");
      },
      { idleTimeoutMs: 200, waitUntil: (task) => tasks.push(task) },
    );
    assert.equal(
      await (await fixture.connector.send(new Request(fixture.url))).text(),
      "ok",
    );
    assert.equal(tasks.length, 1);
    const response = await fixture.connector.send(
      new Request(`${fixture.url}/stream`),
    );
    const reader = response.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "first",
    );
    await tasks[0];
    assert.equal(sockets[0], sockets[1]);
    // An idle deadline must not destroy a socket that is now serving an active stream.
    await new Promise((resolve) => setTimeout(resolve, 300));
    stream.end("last");
    assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
    assert.equal((await reader.read()).done, true);
    assert.equal(tasks.length, 2);
    await tasks[1];
    assert.equal(
      await (await fixture.connector.send(new Request(fixture.url))).text(),
      "ok",
    );
    assert.notEqual(sockets[1], sockets[2]);
  },
);

test("runtime-scoped connectors keep inference and OAuth requests isolated", async () => {
  const oauth = {
    getByName: () => ({
      run: async () => ({
        ok: true,
        data: { token: "token", project_id: "project" },
      }),
    }),
  };
  const first = {
    UPSTREAM_HTTP: { antigravity: async () => new Response("first") },
    PROVIDER_OAUTH_ACCOUNT: oauth,
    CONFIG_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
  const second = {
    ...first,
    UPSTREAM_HTTP: { antigravity: async () => new Response("second") },
  };
  const config = { proxy_groups: [] };
  const signal = new AbortController().signal;
  const credential = {
    id: "one",
    auth: { type: "oauth", account_ref: crypto.randomUUID() },
  };
  const provider = {
    id: crypto.randomUUID(),
    type: "antigravity",
    credentials: [credential],
  };
  const transport = (env) =>
    prepareProviderRequest(
      provider,
      credential,
      {
        request: new Request("https://gateway.invalid/responses", { signal }),
        endpoint: "responses",
        transport: "http",
        protocol: "openai",
        model: "gemini-3-pro",
        clientId: "client",
        payload: { input: "hello" },
      },
      {
        env,
        config,
      },
    );
  const a = await transport(first);
  const b = await transport(second);
  const request = () => new Request("https://upstream.invalid");
  assert.equal(await (await a.send(request())).text(), "first");
  assert.equal(await (await b.send(request())).text(), "second");
  const outbound = providerOutbound(
    { provider_id: provider.id, credential_id: "one" },
    config,
    first,
    signal,
    "antigravity",
  );
  assert.equal(await (await outbound.send(request())).text(), "first");
});

test("default direct transport is preserved without a provider connector", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("fetch"));
  const env = {
    UPSTREAM_HTTP: {
      antigravity: () => assert.fail("other providers must use fetch"),
    },
  };
  for (const type of ["antigravity", "codex", "claude", "xai"]) {
    const outbound = providerOutbound(
      {
        provider_id: crypto.randomUUID(),
        credential_id: crypto.randomUUID(),
        provider_proxy_group: "unused",
        credential_proxy_group: null,
      },
      { proxy_groups: [] },
      type === "antigravity" ? {} : env,
      new AbortController().signal,
      type,
    );
    assert.equal(
      await (
        await outbound.send(new Request("https://upstream.invalid"))
      ).text(),
      "fetch",
    );
  }
});
