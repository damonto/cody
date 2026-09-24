import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "./admin/fixtures.ts";
import { tlsProxyFixture } from "./helpers/socks-fixture.mjs";
import { createRuntime } from "../src/platform/standard/runtime.ts";
import { createNodeServer } from "../src/platform/standard/server.ts";
import { MemoryRedis } from "../src/platform/standard/redis.ts";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import { nodeSocksDial } from "../src/platform/standard/socket.ts";
import { socksFetch } from "../src/gateway/transport/socks-fetch.ts";
import { clearConfigCacheForTests } from "../src/config/store.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test(
  "native Node serves the console and proxies HTTP, SSE and WebSocket",
  { timeout: 20_000 },
  async (t) => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cody-node-server-"));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    // Unit tests run before build:web in CI; serve an isolated fixture bundle.
    const consoleRoot = path.join(runtimeRoot, "console", "dist");
    const consoleHtml =
      '<!doctype html><title>Console fixture</title><div id="root"></div>';
    const consoleScript =
      'document.querySelector("#root").textContent = "Console fixture";';
    await mkdir(path.join(consoleRoot, "assets"), { recursive: true });
    await Promise.all([
      writeFile(path.join(consoleRoot, "index.html"), consoleHtml),
      writeFile(path.join(consoleRoot, "assets", "fixture.js"), consoleScript),
    ]);
    const captured = [];
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      captured.push({ url: request.url, headers: request.headers, body });
      if (body.stream) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-upstream": "preserved",
        });
        response.write(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        );
        setTimeout(
          () =>
            response.end(
              'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            ),
          10,
        );
      } else {
        response.writeHead(200, {
          "content-type": "application/json",
          "x-upstream": "preserved",
        });
        response.end(
          JSON.stringify({
            id: "response-test",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }
    });
    const upstreamSockets = new WebSocketServer({ server: upstream });
    upstreamSockets.on("connection", (socket, request) => {
      socket.on("message", (message, binary) => {
        if (binary) {
          socket.send(message, { binary: true });
          return;
        }
        captured.push({
          url: request.url,
          headers: request.headers,
          body: JSON.parse(message.toString()),
        });
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "response-ws",
              usage: { input_tokens: 2, output_tokens: 3 },
            },
          }),
        );
      });
    });
    const upstreamUrl = await listen(upstream);
    t.after(async () => {
      for (const socket of upstreamSockets.clients) socket.terminate();
      upstreamSockets.close();
      await new Promise((resolve) => upstream.close(resolve));
    });
    const db = await createSqliteDatabase(":memory:");
    await applyMigrations(db, migrationDirectories("sqlite", ROOT));
    const runtime = await createRuntime({
      target: "node",
      root: runtimeRoot,
      source: {
        DATABASE_URL: "sqlite::memory:",
        REDIS_URL: "redis://localhost:6379",
        CONFIG_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        ADMIN_AUTH_MODE: "token",
        ADMIN_TOKEN: "test-admin-secret",
        CONFIG_CACHE_TTL_SECONDS: "0",
        LOG_LEVEL: "off",
      },
      resources: {
        db,
        redis: new MemoryRedis(),
        close: async () => db.close(),
      },
    });
    const value = config();
    value.providers[0].base_url = `${upstreamUrl}/v1`;
    const publisher =
      runtime.bindings.CONFIG_PUBLISHER.getByName("configuration");
    assert.equal(
      JSON.parse(await publisher.saveDraft(JSON.stringify(value), 0, "tester"))
        .ok,
      true,
    );
    assert.equal(JSON.parse(await publisher.publish(1, "tester")).ok, true);
    const host = createNodeServer(runtime);
    const url = await listen(host.server);
    t.after(async () => {
      await host.close();
      clearConfigCacheForTests();
    });

    const page = await fetch(`${url}/console/providers`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(
      page.headers.get("content-security-policy"),
      /default-src 'self'/,
    );
    assert.equal(await page.text(), consoleHtml);
    const asset = await fetch(`${url}/console/assets/fixture.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /text\/javascript/);
    assert.equal(await asset.text(), consoleScript);
    assert.equal((await fetch(`${url}/console/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${url}/console/api/config`)).status, 401);
    assert.equal(
      (await fetch(`${url}/v1/responses`, { method: "POST", body: "{}" }))
        .status,
      401,
    );
    const headers = {
      "x-api-key": "test-client-secret",
      "content-type": "application/json",
      "session-id": "native-http-session",
      "x-application": "preserved",
    };
    const ordinary = await fetch(`${url}/v1/responses?trace=a&trace=b`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "alias", input: "hello" }),
    });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.headers.get("x-upstream"), "preserved");
    assert.equal((await ordinary.json()).id, "response-test");
    const streaming = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "alias", input: "hello", stream: true }),
    });
    assert.equal(streaming.status, 200);
    assert.match(
      await streaming.text(),
      /response\.output_text\.delta[\s\S]*response\.completed/,
    );

    const client = new WebSocket(
      `${url.replace("http:", "ws:")}/v1/responses?ws=1`,
      {
        headers: {
          authorization: "Bearer test-client-secret",
          "session-id": "native-ws-session",
        },
      },
    );
    t.after(() => client.terminate());
    await once(client, "open");
    const completed = once(client, "message");
    client.send(
      JSON.stringify({
        type: "response.create",
        model: "alias",
        input: "hello",
      }),
    );
    assert.equal(
      JSON.parse((await completed)[0].toString()).type,
      "response.completed",
    );
    const binary = once(client, "message");
    client.send(Buffer.from([1, 2, 3]));
    assert.deepEqual([...(await binary)[0]], [1, 2, 3]);
    const closed = once(client, "close");
    client.close(1000, "done");
    assert.equal((await closed)[0], 1000);
    await runtime.tasks.drain();
    assert.equal(captured.length, 3);
    assert.equal(captured[0].url, "/v1/responses?trace=a&trace=b");
    for (const request of captured) {
      assert.equal(request.body.model, "real-model");
      assert.equal(
        request.headers.authorization,
        "Bearer test-upstream-secret",
      );
      assert.equal(request.headers["x-api-key"], undefined);
    }
    const rows = await db
      .prepare(
        "SELECT protocol, finished_at, outcome FROM requests WHERE endpoint = 'responses'",
      )
      .all();
    assert.ok(
      rows.results.filter((row) => row.finished_at !== null).length >= 3,
    );
  },
);

test(
  "native SOCKS dialer carries TLS traffic",
  { timeout: 10_000 },
  async () => {
    const fixture = await tlsProxyFixture((_request, response) => {
      response.end("via-socks");
    });
    try {
      const response = await socksFetch(
        new Request(`${fixture.url}/hello`),
        fixture.proxy,
        { ...fixture.options, dial: nodeSocksDial },
      );
      assert.equal(await response.text(), "via-socks");
      assert.equal(fixture.destinations[0].host, "upstream.test");
    } finally {
      await fixture.close();
    }
  },
);
