import {
  applyD1Migrations,
  createExecutionContext,
  evictDurableObject,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { clearConfigCacheForTests } from "../../src/config/store.ts";
import { FAILURE_THRESHOLD } from "../../src/gateway/health/health.ts";
import { gatewayApp as worker } from "../../src/gateway/app.ts";
import { ResponsesWebSocketProxy } from "../../src/platform/cloudflare/objects.ts";
import type {
  GatewayConfig,
  AiGatewayProviderConfig,
} from "../../src/config/types.ts";
import { requestDetail } from "../../src/reporting/store.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";

beforeAll(async () => {
  const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS);
});

interface UpstreamMessage {
  kind: "text" | "binary";
  data: string | number[];
}

interface UpstreamClose {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface UpstreamPair {
  id: string;
  pendingMessages: UpstreamMessage[];
  pendingCloses: UpstreamClose[];
}

function gatewayConfig(): Omit<GatewayConfig, "providers"> & {
  providers: AiGatewayProviderConfig[];
} {
  return {
    proxy_groups: [],
    providers: [
      {
        type: "ai_gateway",
        id: "primary",
        base_url: "https://primary.example/v1",
        credentials: [
          {
            id: "primary-key",
            auth: { type: "api_key", api_key: "primary-secret" },
            disabled: false,
            priority: 100,
          },
          {
            id: "backup-key",
            auth: { type: "api_key", api_key: "backup-secret" },
            disabled: false,
            priority: 50,
          },
        ],
        disabled: false,
        priority: 100,
        supports_websocket: true,
        supports_web_search: false,
        supports_context_management: false,
        anthropic_1m_context: false,
        emulate_claude_code: false,
        models: ["upstream-model", "other-model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client-secret", providers: ["primary"] },
    ],
    web_search: { mode: "proxy" },
    model_routes: {
      "client-model": { model: "upstream-model" },
    },
  };
}

function upstreamPair(): UpstreamPair {
  return {
    id: crypto.randomUUID(),
    pendingMessages: [],
    pendingCloses: [],
  };
}

function testUpstream(): Fetcher {
  const binding = Reflect.get(env, "TEST_UPSTREAM");
  if (
    typeof binding !== "object" ||
    binding === null ||
    typeof Reflect.get(binding, "fetch") !== "function"
  ) {
    throw new Error("TEST_UPSTREAM service binding is unavailable");
  }
  return binding as Fetcher;
}

function upstreamControlUrl(
  upstream: UpstreamPair,
  path: string,
  parameters: Record<string, string> = {},
): URL {
  const url = new URL(`https://test-upstream${path}`);
  url.searchParams.set("connection_id", upstream.id);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url;
}

function openUpstream(
  upstream: UpstreamPair,
  handshakeDelayMs = 0,
): Promise<Response> {
  const url = upstreamControlUrl(upstream, "/responses");
  if (handshakeDelayMs > 0) {
    url.searchParams.set("handshake_delay_ms", String(handshakeDelayMs));
  }
  return testUpstream().fetch(
    new Request(url, {
      method: "GET",
      headers: { upgrade: "websocket" },
    }),
  );
}

async function takeUpstreamMessages(upstream: UpstreamPair): Promise<void> {
  const response = await testUpstream().fetch(
    new Request(upstreamControlUrl(upstream, "/__test/messages")),
  );
  if (response.status === 404) {
    return;
  }
  const body = await response.json<{ messages: UpstreamMessage[] }>();
  upstream.pendingMessages.push(...body.messages);
}

async function takeUpstreamCloses(upstream: UpstreamPair): Promise<void> {
  const response = await testUpstream().fetch(
    new Request(upstreamControlUrl(upstream, "/__test/closes")),
  );
  if (response.status === 404) {
    return;
  }
  const body = await response.json<{ closes: UpstreamClose[] }>();
  upstream.pendingCloses.push(...body.closes);
}

async function waitForUpstreamItem<T>(
  upstream: UpstreamPair,
  pending: T[],
  take: (upstream: UpstreamPair) => Promise<void>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (pending.length === 0 && Date.now() < deadline) {
    await take(upstream);
    if (pending.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const item = pending.shift();
  if (item === undefined) {
    throw new Error(`timed out waiting for ${label}`);
  }
  return item;
}

async function nextUpstreamMessage(
  upstream: UpstreamPair,
): Promise<string | ArrayBuffer> {
  const message = await waitForUpstreamItem(
    upstream,
    upstream.pendingMessages,
    takeUpstreamMessages,
    "upstream websocket message",
  );
  return message.kind === "text"
    ? (message.data as string)
    : new Uint8Array(message.data as number[]).buffer;
}

function nextUpstreamClose(upstream: UpstreamPair): Promise<UpstreamClose> {
  return waitForUpstreamItem(
    upstream,
    upstream.pendingCloses,
    takeUpstreamCloses,
    "upstream websocket close",
  );
}

async function sendUpstream(
  upstream: UpstreamPair,
  message: string | ArrayBuffer,
): Promise<void> {
  await testUpstream().fetch(
    new Request(upstreamControlUrl(upstream, "/__test/send"), {
      method: "POST",
      headers: typeof message === "string" ? {} : { "x-test-binary": "1" },
      body: message,
    }),
  );
}

async function sendAndCloseUpstream(
  upstream: UpstreamPair,
  message: string,
  code: number,
  reason: string,
): Promise<void> {
  await testUpstream().fetch(
    new Request(
      upstreamControlUrl(upstream, "/__test/send-and-close", {
        code: String(code),
        reason,
      }),
      {
        method: "POST",
        body: message,
      },
    ),
  );
}

async function closeUpstream(
  upstream: UpstreamPair,
  code: number,
  reason: string,
): Promise<void> {
  await testUpstream().fetch(
    new Request(
      upstreamControlUrl(upstream, "/__test/close", {
        code: String(code),
        reason,
      }),
      { method: "POST" },
    ),
  );
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      2_000,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function nextMessage(socket: WebSocket): Promise<string | ArrayBuffer> {
  return withTimeout(
    new Promise((resolve) => {
      socket.addEventListener(
        "message",
        (event) => {
          if (
            typeof event.data === "string" ||
            event.data instanceof ArrayBuffer
          ) {
            resolve(event.data);
            return;
          }
          if (event.data instanceof Blob) {
            void event.data.arrayBuffer().then(resolve);
          }
        },
        { once: true },
      );
    }),
    "websocket message",
  );
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return withTimeout(
    new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    }),
    "websocket close",
  );
}

async function putConfig(
  config: ReturnType<typeof gatewayConfig>,
): Promise<void> {
  clearConfigCacheForTests();
  await env.CODY_CONFIG_KV.put("gateway-config", JSON.stringify(config));
}

async function clearRoutingState(): Promise<void> {
  const [healthIds, affinityIds] = await Promise.all([
    listDurableObjectIds(env.HEALTH),
    listDurableObjectIds(env.SESSION_AFFINITY),
  ]);
  await Promise.all([
    ...healthIds.map((id) => env.HEALTH.get(id).clear()),
    ...affinityIds.map((id) => env.SESSION_AFFINITY.get(id).clear()),
  ]);
}

async function openGatewaySocket(
  path = "/v1/responses",
  extraHeaders: Record<string, string> = {},
): Promise<{
  socket: WebSocket;
  context: ExecutionContext;
  proxy: DurableObjectStub<ResponsesWebSocketProxy>;
}> {
  const existingIds = new Set(
    (await listDurableObjectIds(env.RESPONSES_WEBSOCKET)).map((id) =>
      id.toString(),
    ),
  );
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://gateway.example${path}`, {
      method: "GET",
      headers: {
        authorization: "Bearer client-secret",
        connection: "Upgrade",
        upgrade: "websocket",
        ...extraHeaders,
      },
    }),
    env,
    context,
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer";
  socket.accept({ allowHalfOpen: true });
  const createdId = (await listDurableObjectIds(env.RESPONSES_WEBSOCKET)).find(
    (id) => !existingIds.has(id.toString()),
  );
  if (!createdId) {
    throw new Error("Responses WebSocket Durable Object was not created");
  }
  return {
    socket,
    context,
    proxy: env.RESPONSES_WEBSOCKET.get(createdId),
  };
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  clearConfigCacheForTests();
  await clearRoutingState();
});

test("a native thread hint and subsequent WebSocket windows share the same context binding", async () => {
  const config = gatewayConfig();
  config.model_routes["gpt-6-astra"] = { model: "upstream-model" };
  config.providers.push({
    ...config.providers[0],
    id: "context",
    base_url: "https://context.example/v1",
    priority: 50,
    supports_context_management: true,
  });
  config.api_keys[0].providers.push("context");
  await putConfig(config);
  const upstream = upstreamPair();
  const captured: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      captured.push(request);
      return request.headers.get("upgrade") === "websocket"
        ? openUpstream(upstream)
        : Response.json({ text: "checkpoint" });
    }),
  );
  const session = crypto.randomUUID();
  const hintContext = createExecutionContext();
  const hint = await worker.fetch(
    new Request("https://gateway.example/alpha/notes/v2/thread_hint", {
      method: "POST",
      headers: {
        authorization: "Bearer client-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        context: { session_id: session, current_agent_name: "/root" },
      }),
    }),
    env,
    hintContext,
  );
  expect(hint.status).toBe(200);
  await waitOnExecutionContext(hintContext);
  config.providers[0].supports_context_management = true;
  await putConfig(config);
  const { socket, proxy } = await openGatewaySocket();
  const frame = {
    type: "response.create",
    model: "client-model",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        session_id: session,
        history_ingest_requested: true,
        context_window_id: "first",
      }),
    },
  };
  const first = nextUpstreamMessage(upstream);
  socket.send(JSON.stringify(frame));
  expect(JSON.parse((await first) as string)).toMatchObject({
    model: "upstream-model",
    client_metadata: frame.client_metadata,
  });
  expect(captured.map((request) => new URL(request.url).hostname)).toEqual([
    "context.example",
    "context.example",
  ]);
  await runInDurableObject(proxy, async (_instance, state) => {
    expect(await state.storage.get("session")).toMatchObject({
      context_management: true,
    });
  });
  const second = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({
      ...frame,
      client_metadata: {
        session_id: session,
        "x-codex-turn-metadata": JSON.stringify({
          session_id: session,
          history_ingest_requested: true,
          context_window_id: "second",
        }),
      },
    }),
  );
  expect(
    JSON.parse((await second) as string).client_metadata[
      "x-codex-turn-metadata"
    ],
  ).toContain("second");
  const closed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await closed;
});

test("an existing WebSocket adopts a context binding created by a native request", async () => {
  const config = gatewayConfig();
  config.model_routes["gpt-6-astra"] = { model: "upstream-model" };
  config.providers[0].supports_context_management = false;
  await putConfig(config);
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) =>
      request.headers.get("upgrade") === "websocket"
        ? openUpstream(upstream)
        : Response.json({ text: "checkpoint" }),
    ),
  );
  const session = crypto.randomUUID();
  const { socket } = await openGatewaySocket();
  const first = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "client-model",
      client_metadata: { session_id: session },
    }),
  );
  await first;

  config.providers[0].supports_context_management = true;
  await putConfig(config);
  const hintContext = createExecutionContext();
  const hint = await worker.fetch(
    new Request("https://gateway.example/alpha/notes/v2/thread_hint", {
      method: "POST",
      headers: {
        authorization: "Bearer client-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        context: { session_id: session, current_agent_name: "/root" },
      }),
    }),
    env,
    hintContext,
  );
  expect(hint.status).toBe(200);
  await waitOnExecutionContext(hintContext);

  const error = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "client-model",
      client_metadata: { session_id: crypto.randomUUID() },
    }),
  );
  expect(JSON.parse((await error) as string)).toMatchObject({
    error: { code: "invalid_context_management_request" },
  });
  await closed;
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("context WebSockets require both capabilities and recheck the bound capability on later frames", async () => {
  const config = gatewayConfig();
  config.providers[0].supports_context_management = true;
  config.providers[0].supports_websocket = false;
  config.providers.push({
    ...config.providers[0],
    id: "context-ws",
    base_url: "https://context-ws.example/v1",
    priority: 50,
    supports_websocket: true,
  });
  config.api_keys[0].providers.push("context-ws");
  await putConfig(config);
  const upstream = upstreamPair();
  const fetch = vi.fn(async (request: Request) => {
    expect(new URL(request.url).hostname).toBe("context-ws.example");
    return openUpstream(upstream);
  });
  vi.stubGlobal("fetch", fetch);
  const { socket } = await openGatewaySocket();
  const session = crypto.randomUUID();
  const first = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "client-model",
      client_metadata: {
        session_id: session,
        "x-codex-turn-metadata": JSON.stringify({
          history_ingest_requested: true,
        }),
      },
    }),
  );
  await first;
  config.providers[1].supports_context_management = false;
  await putConfig(config);
  const error = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "client-model",
      client_metadata: { session_id: session },
    }),
  );
  expect(JSON.parse((await error) as string)).toMatchObject({
    error: { code: "websocket_reconnect_required" },
  });
  await closed;
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("context WebSockets reject ingestion without a session identity", async () => {
  const config = gatewayConfig();
  config.providers[0].supports_context_management = true;
  await putConfig(config);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { socket } = await openGatewaySocket();
  const error = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "client-model",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          history_ingest_requested: true,
        }),
      },
    }),
  );
  expect(JSON.parse((await error) as string)).toMatchObject({
    error: { code: "invalid_context_management_request" },
  });
  await closed;
  expect(fetch).not.toHaveBeenCalled();
});

test("context WebSockets reject a frame session conflicting with the handshake header", async () => {
  const config = gatewayConfig();
  config.providers[0].supports_context_management = true;
  await putConfig(config);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { socket } = await openGatewaySocket("/v1/responses", {
    "session-id": "header-session",
  });
  const error = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "client-model",
      client_metadata: {
        session_id: "other-session",
        "x-codex-turn-metadata": JSON.stringify({
          history_ingest_requested: true,
        }),
      },
    }),
  );
  expect(JSON.parse((await error) as string)).toMatchObject({
    error: { code: "invalid_context_management_request" },
  });
  await closed;
  expect(fetch).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("responses WebSocket rewrites the first model and proxies headers, text, binary, and close", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket, context } = await openGatewaySocket("/responses?trace=yes", {
    "cf-connecting-ip": "203.0.113.8",
    "sec-websocket-key": "client-generated",
    "session-id": "websocket-session",
    "x-openai-actor-authorization": "cody",
    "x-oai-attestation": "device-attestation",
    "chatgpt-account-id": "account-id",
    "x-tenant": "tenant-a",
  });
  const originalFirstFrame = JSON.stringify({
    type: "response.create",
    model: "client-model",
    client_metadata: { session_id: "metadata-session" },
    input: "hello",
  });
  const upstreamFirstMessage = nextUpstreamMessage(upstream);
  socket.send(originalFirstFrame);
  expect(JSON.parse((await upstreamFirstMessage) as string)).toEqual({
    type: "response.create",
    model: "upstream-model",
    client_metadata: { session_id: "metadata-session" },
    input: "hello",
  });

  expect(capturedRequest?.url).toBe(
    "https://primary.example/v1/responses?trace=yes",
  );
  expect(capturedRequest?.method).toBe("GET");
  expect(capturedRequest?.headers.get("authorization")).toBe(
    "Bearer primary-secret",
  );
  expect(capturedRequest?.headers.get("upgrade")).toBe("websocket");
  expect(capturedRequest?.headers.get("x-tenant")).toBe("tenant-a");
  expect(capturedRequest?.headers.get("cf-connecting-ip")).toBeNull();
  expect(capturedRequest?.headers.get("sec-websocket-key")).toBeNull();
  expect(
    capturedRequest?.headers.get("x-openai-actor-authorization"),
  ).toBeNull();
  expect(capturedRequest?.headers.get("x-oai-attestation")).toBeNull();
  expect(capturedRequest?.headers.get("chatgpt-account-id")).toBeNull();

  const clientText = nextMessage(socket);
  await sendUpstream(
    upstream,
    '{"type":"response.output_text.delta","delta":"hello"}',
  );
  expect(await clientText).toBe(
    '{"type":"response.output_text.delta","delta":"hello"}',
  );

  const upstreamBinary = nextUpstreamMessage(upstream);
  socket.send(new Uint8Array([1, 2, 3]).buffer);
  expect([...new Uint8Array((await upstreamBinary) as ArrayBuffer)]).toEqual([
    1, 2, 3,
  ]);

  const clientBinary = nextMessage(socket);
  await sendUpstream(upstream, new Uint8Array([4, 5, 6]).buffer);
  expect([...new Uint8Array((await clientBinary) as ArrayBuffer)]).toEqual([
    4, 5, 6,
  ]);

  const unchangedFrame =
    '{ "type": "response.create", "model": "upstream-model", "input": "next" }';
  const unchangedUpstream = nextUpstreamMessage(upstream);
  socket.send(unchangedFrame);
  expect(await unchangedUpstream).toBe(unchangedFrame);

  const completed = '{"type":"response.completed"}';
  const clientCompleted = nextMessage(socket);
  await sendUpstream(upstream, completed);
  expect(await clientCompleted).toBe(completed);
  await waitOnExecutionContext(context);

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "client done");
  expect((await upstreamClosed).code).toBe(1000);
});

test("responses WebSocket applies per-client model routes over the global routes", async () => {
  const config = gatewayConfig();
  config.api_keys = [
    config.api_keys[0],
    {
      id: "per-key-client",
      api_key: "per-key-client-secret",
      providers: ["primary"],
      model_routes: {
        "client-model": { model: "other-model", providers: ["primary"] },
      },
    },
  ];
  await putConfig(config);
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket } = await openGatewaySocket("/v1/responses", {
    authorization: "Bearer per-key-client-secret",
  });
  const upstreamFirstMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await upstreamFirstMessage) as string)).toMatchObject({
    type: "response.create",
    model: "other-model",
  });
  expect(capturedRequest?.url).toBe("https://primary.example/v1/responses");
  expect(capturedRequest?.headers.get("authorization")).toBe(
    "Bearer primary-secret",
  );

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("responses WebSocket applies provider model routes over per-client and global routes", async () => {
  const config = gatewayConfig();
  config.providers[0].model_routes = {
    "client-model": { model: "other-model" },
  };
  config.api_keys[0].model_routes = {
    "client-model": { model: "upstream-model" },
  };
  await putConfig(config);
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket } = await openGatewaySocket("/v1/responses", {
    authorization: "Bearer client-secret",
  });
  const upstreamFirstMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await upstreamFirstMessage) as string)).toMatchObject({
    type: "response.create",
    model: "other-model",
  });
  expect(capturedRequest?.url).toBe("https://primary.example/v1/responses");

  const upstreamSecondMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await upstreamSecondMessage) as string)).toMatchObject({
    type: "response.create",
    model: "other-model",
  });

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("responses WebSocket skips higher-priority providers without WebSocket support", async () => {
  const config = gatewayConfig();
  config.providers[0].supports_websocket = false;
  config.providers.push({
    type: "ai_gateway",
    id: "websocket",
    base_url: "https://websocket.example/v1",
    credentials: [
      {
        id: "websocket-key",
        auth: { type: "api_key", api_key: "websocket-secret" },
        disabled: false,
        priority: 100,
      },
    ],
    disabled: false,
    priority: 50,
    supports_websocket: true,
    supports_web_search: false,
    supports_context_management: false,
    anthropic_1m_context: false,
    emulate_claude_code: false,
    models: ["upstream-model"],
  });
  config.api_keys[0].providers.push("websocket");
  await putConfig(config);
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket } = await openGatewaySocket();
  const firstMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstMessage;

  expect(capturedRequest?.url).toBe("https://websocket.example/v1/responses");
  expect(capturedRequest?.headers.get("authorization")).toBe(
    "Bearer websocket-secret",
  );

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("responses WebSocket does not connect when no provider declares WebSocket support", async () => {
  const config = gatewayConfig();
  config.providers[0].supports_websocket = false;
  await putConfig(config);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const { socket } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 400,
    error: { code: "model_not_found" },
  });
  expect((await closed).code).toBe(1008);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the first frame must be a response.create JSON text frame", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { socket } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);

  socket.send(new Uint8Array([1, 2, 3]).buffer);
  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 400,
    error: { code: "invalid_websocket_first_frame" },
  });
  expect((await closed).code).toBe(1008);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a WebSocket session emits one structured terminal lifecycle log", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    const { socket } = await openGatewaySocket();
    const closed = nextClose(socket);
    socket.send(
      JSON.stringify({ type: "response.create", input: "missing model" }),
    );
    expect((await closed).code).toBe(1008);

    const lifecycle = warn.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { event?: unknown }).event === "websocket.closed",
      );
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({
      event: "websocket.closed",
      outcome: "invalid_first_frame",
      close_code: 1008,
      phase: "awaiting_first_frame",
      active_response: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("a connection without a valid first frame times out after 10 seconds", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { socket, proxy } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  await runInDurableObject(proxy, async (_instance, state) => {
    const session = await state.storage.get<Record<string, unknown>>("session");
    if (!session) {
      throw new Error("WebSocket session state is missing");
    }
    await state.storage.put("session", {
      ...session,
      first_frame_deadline: Date.now() - 1,
    });
  });

  expect(await runDurableObjectAlarm(proxy)).toBe(true);
  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 408,
    error: { code: "websocket_first_frame_timeout" },
  });
  expect((await closed).code).toBe(1008);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an expired first-frame alarm cannot close a session already claimed for routing", async () => {
  await putConfig(gatewayConfig());
  const { socket, proxy } = await openGatewaySocket();
  await runInDurableObject(proxy, async (_instance, state) => {
    const session = await state.storage.get<Record<string, unknown>>("session");
    if (!session) {
      throw new Error("WebSocket session state is missing");
    }
    await state.storage.put("session", {
      ...session,
      phase: "routing",
      first_frame_deadline: Date.now() - 1,
    });
  });

  expect(await runDurableObjectAlarm(proxy)).toBe(true);
  await runInDurableObject(proxy, async (_instance, state) => {
    expect(await state.storage.get("session")).toMatchObject({
      phase: "routing",
    });
  });
  expect(socket.readyState).toBe(WebSocket.OPEN);
  const closed = nextClose(socket);
  await runInDurableObject(
    proxy,
    async (instance: ResponsesWebSocketProxy, state) => {
      const server = state.getWebSockets("client")[0];
      if (!server) {
        throw new Error("Client WebSocket is missing");
      }
      await instance.webSocketClose(server, 1000, "done", true);
    },
  );
  expect((await closed).code).toBe(1000);
  await vi.waitFor(async () => {
    await runInDurableObject(proxy, async (_instance, state) => {
      expect(await state.storage.get("session")).toBeUndefined();
    });
  });
});

test("more than 32 MiB of queued client messages closes the connection", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => {
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { socket } = await openGatewaySocket();
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  const chunk = new ArrayBuffer(17 * 1024 * 1024);
  socket.send(chunk);
  socket.send(chunk.slice(0));

  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 413,
    error: { code: "websocket_queue_too_large" },
  });
  expect((await closed).code).toBe(1009);
});

test("the client WebSocket survives Durable Object hibernation before routing", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket, proxy } = await openGatewaySocket();
  await evictDurableObject(proxy);

  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await firstUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "upstream-model",
  });

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("closing during the upstream handshake cannot revive a closed session", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  let releaseHandshake!: () => void;
  const handshake = new Promise<void>((resolve) => {
    releaseHandshake = resolve;
  });
  const fetchMock = vi.fn(async () => {
    await handshake;
    return openUpstream(upstream);
  });
  vi.stubGlobal("fetch", fetchMock);

  try {
    const { socket, proxy } = await openGatewaySocket();
    socket.send(
      JSON.stringify({ type: "response.create", model: "client-model" }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    socket.close(1000, "client left");
    await vi.waitFor(async () => {
      await runInDurableObject(proxy, async (_instance, state) => {
        expect(await state.storage.get("session")).toBeUndefined();
      });
    });

    const upstreamClosed = nextUpstreamClose(upstream);
    releaseHandshake();
    expect(await upstreamClosed).toMatchObject({
      code: 1000,
      reason: "client disconnected",
    });
    await runInDurableObject(proxy, async (_instance, state) => {
      expect(await state.storage.get("session")).toBeUndefined();
    });
    await takeUpstreamMessages(upstream);
    expect(upstream.pendingMessages).toHaveLength(0);
  } finally {
    releaseHandshake();
  }
});

test("an upstream WebSocket handshake times out after 10 seconds", async () => {
  await putConfig(gatewayConfig());
  const realSetTimeout = globalThis.setTimeout;
  vi.stubGlobal(
    "setTimeout",
    (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ): number | ReturnType<typeof setTimeout> => {
      if (delay === 10_000) {
        callback(...args);
        return 0;
      }
      return realSetTimeout(callback, delay, ...args);
    },
  );
  let requestAborted = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      if (request.signal.aborted) {
        requestAborted = true;
        reject(request.signal.reason);
        return;
      }
      request.signal.addEventListener(
        "abort",
        () => {
          requestAborted = true;
          reject(request.signal.reason);
        },
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const { socket } = await openGatewaySocket();
  const errorMessage = new Promise<string | ArrayBuffer>((resolve) => {
    socket.addEventListener(
      "message",
      (event) => {
        if (
          typeof event.data === "string" ||
          event.data instanceof ArrayBuffer
        ) {
          resolve(event.data);
        }
      },
      { once: true },
    );
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 504,
    error: { code: "upstream_handshake_timeout" },
  });
  expect((await closed).code).toBe(1011);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(requestAborted).toBe(true);
  await vi.waitFor(async () => {
    expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(
      1,
    );
  });
});

test("a retrying 403 handshake cools the key, keeps the same key for retry, then rebinds on reconnect", async () => {
  const config = gatewayConfig();
  config.providers[0].retry = { status_codes: [403], delays_ms: [0] };
  await putConfig(config);
  const retryUpstream = upstreamPair();
  const reboundUpstream = upstreamPair();
  const authorizations: string[] = [];
  let attempt = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      attempt += 1;
      if (attempt === 1) {
        return new Response('{"error":"forbidden"}', { status: 403 });
      }
      return attempt === 2
        ? openUpstream(retryUpstream)
        : openUpstream(reboundUpstream);
    }),
  );

  const first = await openGatewaySocket("/v1/responses", {
    "session-id": "retry-session",
  });
  const firstUpstreamMessage = nextUpstreamMessage(retryUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await firstUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "upstream-model",
  });
  await waitOnExecutionContext(first.context);
  expect(authorizations.slice(0, 2)).toEqual([
    "Bearer primary-secret",
    "Bearer primary-secret",
  ]);
  expect(
    (await env.HEALTH.getByName("key:primary:primary-key").getStatus())
      .cooling_until,
  ).toBeTypeOf("number");

  const firstUpstreamClosed = nextUpstreamClose(retryUpstream);
  first.socket.close(1000, "reconnect");
  await firstUpstreamClosed;

  const second = await openGatewaySocket("/v1/responses", {
    "session-id": "retry-session",
  });
  const secondUpstreamMessage = nextUpstreamMessage(reboundUpstream);
  second.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await secondUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "upstream-model",
  });
  expect(authorizations.at(-1)).toBe("Bearer backup-secret");

  const secondUpstreamClosed = nextUpstreamClose(reboundUpstream);
  second.socket.close(1000, "done");
  await secondUpstreamClosed;
});

test("a final upstream handshake rejection is forwarded and records provider health", async () => {
  await putConfig(gatewayConfig());
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response('{"error":"temporarily unavailable"}', {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    ),
  );

  const { socket, context } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(await errorMessage).toBe('{"error":"temporarily unavailable"}');
  expect((await closed).code).toBe(1011);
  await waitOnExecutionContext(context);
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(1);
});

test("an unavailable proxy group sends a WebSocket 503 without cooling the provider or using direct fetch", async () => {
  const config = gatewayConfig();
  config.proxy_groups = [
    { id: `empty-${crypto.randomUUID()}`, strategy: "random", proxies: [] },
  ];
  config.providers[0].proxy_group = config.proxy_groups[0].id;
  await putConfig(config);
  const fetch = vi.fn(async () => new Response("unexpected direct connection"));
  vi.stubGlobal("fetch", fetch);
  const { socket, context } = await openGatewaySocket();
  const message = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  const received = await message;
  if (typeof received !== "string")
    throw new Error("Expected a JSON error frame");
  expect(JSON.parse(received)).toMatchObject({
    type: "error",
    error: { code: "proxy_group_unavailable" },
  });
  expect((await closed).code).toBe(1011);
  await waitOnExecutionContext(context);
  expect(fetch).not.toHaveBeenCalled();
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(0);
});

test("an upstream 402 frame is processed before an immediate close", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, context } = await openGatewaySocket();
  const upstreamFirst = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await upstreamFirst;

  const errorFrame = JSON.stringify({
    type: "error",
    error: {
      status_code: "402",
      code: "billing_error",
      message: "payment required",
    },
  });
  const forwarded = nextMessage(socket);
  const closed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  await sendAndCloseUpstream(upstream, errorFrame, 1011, "billing rejected");
  expect(await forwarded).toBe(errorFrame);
  expect((await closed).code).toBe(1011);
  await upstreamClosed;
  await waitOnExecutionContext(context);
  expect(
    (await env.HEALTH.getByName("key:primary:primary-key").getStatus())
      .cooling_until,
  ).toBeTypeOf("number");
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(0);
});

test("an upstream 403 frame cools the key when the client socket is unavailable", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, proxy, context } = await openGatewaySocket();
  const upstreamFirst = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await upstreamFirst;

  await runInDurableObject(proxy, async (_instance, state) => {
    const client = state.getWebSockets("client")[0];
    if (!client) {
      throw new Error("Client WebSocket is missing");
    }
    client.close(1000, "simulate unavailable client");
  });

  const upstreamClosed = nextUpstreamClose(upstream);
  await sendUpstream(
    upstream,
    JSON.stringify({
      type: "error",
      error: {
        status_code: 403,
        code: "forbidden",
        message: "access denied",
      },
    }),
  );
  await upstreamClosed;
  await waitOnExecutionContext(context);

  expect(
    (await env.HEALTH.getByName("key:primary:primary-key").getStatus())
      .cooling_until,
  ).toBeTypeOf("number");
});

test("every upstream error frame is forwarded before the connection closes", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket } = await openGatewaySocket();
  const upstreamFirst = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await upstreamFirst;

  const errorFrame = JSON.stringify({
    type: "error",
    error: { code: "upstream_error", message: "request failed" },
  });
  const forwarded = nextMessage(socket);
  const closed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  await sendUpstream(upstream, errorFrame);

  expect(await forwarded).toBe(errorFrame);
  expect((await closed).code).toBe(1011);
  await upstreamClosed;
});

test("an unexpected upstream close propagates and records a provider failure", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, context } = await openGatewaySocket();
  const firstFrame = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstFrame;

  const clientClosed = nextClose(socket);
  await closeUpstream(upstream, 1011, "upstream lost");
  expect((await clientClosed).code).toBe(1011);
  await waitOnExecutionContext(context);
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(1);
});

test("an upstream close while connecting records a provider failure", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, proxy, context } = await openGatewaySocket();
  const firstFrame = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstFrame;

  await runInDurableObject(proxy, async (_instance, state) => {
    const session = await state.storage.get<Record<string, unknown>>("session");
    if (!session) {
      throw new Error("WebSocket session state is missing");
    }
    await state.storage.put("session", {
      ...session,
      phase: "connecting",
      active_response: false,
      response_outcome_recorded: false,
    });
  });

  const clientClosed = nextClose(socket);
  await closeUpstream(upstream, 1011, "closed before ready");
  expect((await clientClosed).code).toBe(1011);
  await waitOnExecutionContext(context);
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(1);
});

test("a later response.create that requires another target closes and rebinds on reconnect", async () => {
  const config = gatewayConfig();
  config.providers = [
    {
      type: "ai_gateway",
      id: "first",
      base_url: "https://first.example/v1",
      credentials: [
        {
          id: "first-key",
          auth: { type: "api_key", api_key: "first-secret" },
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 100,
      supports_websocket: true,
      supports_web_search: false,
      supports_context_management: false,
      anthropic_1m_context: false,
      emulate_claude_code: false,
      models: ["model-a"],
    },
    {
      type: "ai_gateway",
      id: "second",
      base_url: "https://second.example/v1",
      credentials: [
        {
          id: "second-key",
          auth: { type: "api_key", api_key: "second-secret" },
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 100,
      supports_websocket: true,
      supports_web_search: false,
      supports_context_management: false,
      anthropic_1m_context: false,
      emulate_claude_code: false,
      models: ["model-b"],
    },
  ];
  config.api_keys[0].providers = ["first", "second"];
  config.model_routes = {
    "client-a": { model: "model-a" },
    "client-b": { model: "model-b" },
  };
  await putConfig(config);
  const firstUpstream = upstreamPair();
  const secondUpstream = upstreamPair();
  const authorizations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      return authorizations.length === 1
        ? openUpstream(firstUpstream)
        : openUpstream(secondUpstream);
    }),
  );

  const first = await openGatewaySocket("/v1/responses", {
    "session-id": "model-switch-session",
  });
  const firstUpstreamMessage = nextUpstreamMessage(firstUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-a" }),
  );
  await firstUpstreamMessage;
  expect(authorizations[0]).toBe("Bearer first-secret");

  const reconnectError = nextMessage(first.socket);
  const firstClosed = nextClose(first.socket);
  const firstUpstreamClosed = nextUpstreamClose(firstUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-b" }),
  );
  expect(JSON.parse((await reconnectError) as string)).toMatchObject({
    type: "error",
    error: { code: "websocket_reconnect_required" },
  });
  expect((await firstClosed).code).toBe(1012);
  await firstUpstreamClosed;
  expect(authorizations).toHaveLength(1);

  const second = await openGatewaySocket("/v1/responses", {
    "session-id": "model-switch-session",
  });
  const secondUpstreamMessage = nextUpstreamMessage(secondUpstream);
  second.socket.send(
    JSON.stringify({ type: "response.create", model: "client-b" }),
  );
  expect(JSON.parse((await secondUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "model-b",
  });
  expect(authorizations[1]).toBe("Bearer second-secret");

  const secondUpstreamClosed = nextUpstreamClose(secondUpstream);
  second.socket.close(1000, "done");
  await secondUpstreamClosed;
});

test("a recovered higher-priority provider changes affinity and requires WebSocket reconnect", async () => {
  const config = gatewayConfig();
  config.providers = [
    {
      type: "ai_gateway",
      id: "higher",
      base_url: "https://higher.example/v1",
      credentials: [
        {
          id: "higher-key",
          auth: { type: "api_key", api_key: "higher-secret" },
          disabled: false,
          priority: 10,
        },
      ],
      disabled: false,
      priority: 100,
      supports_websocket: true,
      supports_web_search: false,
      supports_context_management: false,
      anthropic_1m_context: false,
      emulate_claude_code: false,
      models: ["upstream-model"],
    },
    {
      type: "ai_gateway",
      id: "lower",
      base_url: "https://lower.example/v1",
      credentials: [
        {
          id: "lower-key",
          auth: { type: "api_key", api_key: "lower-secret" },
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 10,
      supports_websocket: true,
      supports_web_search: false,
      supports_context_management: false,
      anthropic_1m_context: false,
      emulate_claude_code: false,
      models: ["upstream-model"],
    },
  ];
  config.api_keys[0].providers = ["higher", "lower"];
  await putConfig(config);
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    await env.HEALTH.getByName("higher").recordFailure();
  }

  const lowerUpstream = upstreamPair();
  const higherUpstream = upstreamPair();
  const authorizations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      return authorizations.length === 1
        ? openUpstream(lowerUpstream)
        : openUpstream(higherUpstream);
    }),
  );

  const first = await openGatewaySocket("/v1/responses", {
    "session-id": "priority-upgrade-session",
  });
  const firstMessage = nextUpstreamMessage(lowerUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstMessage;
  expect(authorizations[0]).toBe("Bearer lower-secret");

  await env.HEALTH.getByName("higher").clear();
  const reconnectError = nextMessage(first.socket);
  const firstClosed = nextClose(first.socket);
  const lowerClosed = nextUpstreamClose(lowerUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await reconnectError) as string)).toMatchObject({
    type: "error",
    error: { code: "websocket_reconnect_required" },
  });
  expect((await firstClosed).code).toBe(1012);
  await lowerClosed;

  const second = await openGatewaySocket("/v1/responses", {
    "session-id": "priority-upgrade-session",
  });
  const secondMessage = nextUpstreamMessage(higherUpstream);
  second.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await secondMessage;
  expect(authorizations[1]).toBe("Bearer higher-secret");

  const higherClosed = nextUpstreamClose(higherUpstream);
  second.socket.close(1000, "done");
  await higherClosed;
});

test("a later response.create reloads configuration and closes when WebSocket support is revoked", async () => {
  const config = gatewayConfig();
  await putConfig(config);
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket } = await openGatewaySocket();
  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstUpstreamMessage;

  const completed = nextMessage(socket);
  await sendUpstream(upstream, JSON.stringify({ type: "response.completed" }));
  await completed;

  config.providers[0].supports_websocket = false;
  await putConfig(config);

  const reconnectError = nextMessage(socket);
  const clientClosed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await reconnectError) as string)).toMatchObject({
    type: "error",
    status: 503,
    error: { code: "websocket_reconnect_required" },
  });
  expect((await clientClosed).code).toBe(1012);
  await upstreamClosed;
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("a later response.create reauthenticates the client against current configuration", async () => {
  const config = gatewayConfig();
  await putConfig(config);
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket } = await openGatewaySocket();
  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstUpstreamMessage;

  const completed = nextMessage(socket);
  await sendUpstream(upstream, JSON.stringify({ type: "response.completed" }));
  await completed;

  config.api_keys = [
    {
      id: "replacement-client",
      api_key: "replacement-client",
      providers: ["primary"],
    },
  ];
  await putConfig(config);

  const authenticationError = nextMessage(socket);
  const clientClosed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await authenticationError) as string)).toMatchObject({
    type: "error",
    status: 401,
    error: { code: "invalid_api_key" },
  });
  expect((await clientClosed).code).toBe(1008);
  await upstreamClosed;
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("an invalid later response.create is rejected instead of bypassing model validation", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket } = await openGatewaySocket();
  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstUpstreamMessage;

  const validationError = nextMessage(socket);
  const clientClosed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", input: "missing model" }),
  );

  expect(JSON.parse((await validationError) as string)).toMatchObject({
    type: "error",
    status: 400,
    error: { code: "invalid_websocket_response_create" },
  });
  expect((await clientClosed).code).toBe(1008);
  await upstreamClosed;
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("custom WebSocket subprotocols are rejected before an upstream connection", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://gateway.example/v1/responses", {
      method: "GET",
      headers: {
        authorization: "Bearer client-secret",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "custom",
      },
    }),
    env,
    context,
  );

  expect(response.status).toBe(400);
  expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
    "websocket_subprotocol_unsupported",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(["/responses", "/v1/responses"])(
  "WebSocket handshakes at %s never enter the usage journal",
  async (path) => {
    await putConfig(gatewayConfig());
    const journal = vi.spyOn(env.USAGE_OUTBOX, "getByName");
    const { socket, context } = await openGatewaySocket(path, {
      upgrade: "WebSocket",
    });
    await waitOnExecutionContext(context);
    expect(journal).not.toHaveBeenCalled();
    socket.close(1000, "done");

    for (const [headers, status] of [
      [{ authorization: "Bearer invalid" }, 401],
      [{ "sec-websocket-protocol": "custom" }, 400],
      [{ upgrade: "" }, 405],
    ] as const) {
      const rejectedContext = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://gateway.example${path}`, {
          headers: {
            authorization: "Bearer client-secret",
            upgrade: "websocket",
            ...headers,
          },
        }),
        env,
        rejectedContext,
      );
      expect(response.status).toBe(status);
      await response.text();
      await waitOnExecutionContext(rejectedContext);
      expect(journal).not.toHaveBeenCalled();
    }
  },
);

test("WebSocket generations retain separate models, timing, usage, and request-time prices", async () => {
  const records: import("../../src/telemetry/types.ts").UsageEvent[] = [];
  const config = gatewayConfig();
  config.revision = 12;
  config.model_policies = ["upstream-model", "other-model"].map(
    (model, index) => ({
      provider_id: "primary",
      model,
      context_window: 1000000,
      pricing: {
        currency: "USD",
        tiers: [
          {
            up_to_input_tokens: null,
            input: String(index + 1),
            output: "10",
            cache_read: "0.1",
            cache_write: "1",
          },
        ],
      },
    }),
  );
  await putConfig(config);
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => openUpstream(upstream)),
  );
  const { socket, context, proxy } = await openGatewaySocket();
  await runInDurableObject(proxy, async (instance) => {
    const bindings = Reflect.get(instance, "env") as Env;
    vi.spyOn(bindings.USAGE_QUEUE, "send").mockImplementation(async (body) => {
      const event = body as import("../../src/telemetry/types.ts").UsageEvent;
      records.push(structuredClone(event));
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
  });
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "client-model",
      input: "never log this prompt",
    }),
  );
  await nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "other-model",
      input: "second prompt",
    }),
  );
  await nextUpstreamMessage(upstream);
  const pending = await runInDurableObject(proxy, async (_instance, state) => [
    ...(await state.storage.list<UsageEvent>({ prefix: "usage:" })).values(),
  ]);
  expect(pending).toHaveLength(2);
  for (const event of pending) {
    await expect
      .poll(() => requestDetail(env.CODY_DB, event.request_id))
      .toMatchObject({
        sequence: 1,
        phase: "started",
        model: event.model,
        client_id: "client",
      });
  }
  expect(records).toEqual([]);
  async function deliver(event: unknown) {
    const received = nextMessage(socket);
    await sendUpstream(upstream, JSON.stringify(event));
    await received;
  }
  await deliver({ type: "response.created", response: { id: "response-a" } });
  await deliver({ type: "response.created", response: { id: "response-b" } });
  await deliver({
    type: "response.reasoning_summary_text.delta",
    response_id: "response-a",
    delta: "private thought",
  });
  await deliver({
    type: "response.output_text.delta",
    response_id: "response-b",
    delta: "second answer",
  });
  await deliver({
    type: "response.output_text.delta",
    response_id: "response-a",
    delta: "first answer",
  });
  const usage = (input: number) => ({
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 2 },
  });
  await deliver({
    type: "response.completed",
    response: { id: "response-b", usage: usage(200) },
  });
  // A late duplicate must not be assigned to the remaining generation.
  await deliver({
    type: "response.completed",
    response: { id: "response-b", usage: usage(999) },
  });
  await deliver({
    type: "response.completed",
    response: { id: "response-a", usage: usage(100) },
  });
  await runInDurableObject(proxy, async () => {});
  await expect.poll(() => records.length).toBe(2);
  expect(records.every((event) => event.phase === "finished")).toBe(true);
  const first = records.find((event) => event.response_id === "response-a")!;
  const second = records.find((event) => event.response_id === "response-b")!;
  expect(first.model).toBe("upstream-model");
  expect(first.requested_model).toBe("client-model");
  expect(first.usage.tokens.input_tokens).toBe(100);
  expect(first.billing.total_nano).toBe(200000);
  expect(second.model).toBe("other-model");
  expect(second.usage.tokens.input_tokens).toBe(200);
  expect(second.billing.total_nano).toBe(500000);
  expect(first.request_id).not.toBe(second.request_id);
  expect(first.connection_id).toBe(second.connection_id);
  expect(first.context_window).toBe(1000000);
  expect(first.billing.price_version).toBe('[12,"primary","upstream-model"]');
  for (const event of [first, second]) {
    expect(event.first_response_ms).toBeTypeOf("number");
    expect(event.first_response_ms!).toBeLessThanOrEqual(event.ttft_ms!);
  }
  expect(first.first_text_ms).toBeTypeOf("number");
  expect(first.ttft_ms!).toBeLessThanOrEqual(first.first_text_ms!);
  expect(JSON.stringify(records)).not.toMatch(
    /private thought|never log this prompt|second answer/,
  );
  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
  await waitOnExecutionContext(context);
});

test("WebSocket terminal delivery persists before sending and retries the same record", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => openUpstream(upstream)),
  );
  const { socket, proxy } = await openGatewaySocket();
  let failDelivery = true;
  const terminals: import("../../src/telemetry/types.ts").UsageEvent[] = [];
  await runInDurableObject(proxy, async (instance, state) => {
    const bindings = Reflect.get(instance, "env") as Env;
    vi.spyOn(bindings.USAGE_QUEUE, "send").mockImplementation(async (body) => {
      const delivered = {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
      const event = body as import("../../src/telemetry/types.ts").UsageEvent;
      if (event.phase !== "finished") return delivered;
      expect(
        await state.storage.get(`usage-outbox:${event.request_id}`),
      ).toEqual(event);
      terminals.push(structuredClone(event));
      if (failDelivery) throw new Error("queue unavailable");
      return delivered;
    });
  });
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await nextUpstreamMessage(upstream);
  const completed = nextMessage(socket);
  await sendUpstream(
    upstream,
    JSON.stringify({
      type: "response.completed",
      response: {
        id: "durable-response",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    }),
  );
  await completed;
  await expect
    .poll(async () =>
      runInDurableObject(
        proxy,
        async (_instance, state) =>
          (await state.storage.list({ prefix: "usage-outbox:" })).size,
      ),
    )
    .toBe(1);
  await expect.poll(() => terminals.length).toBe(1);
  expect(terminals[0].outcome).toBe("success");
  failDelivery = false;
  await runDurableObjectAlarm(proxy);
  expect(terminals).toHaveLength(2);
  expect(terminals[1]).toEqual(terminals[0]);
  expect(
    await runInDurableObject(
      proxy,
      async (_instance, state) =>
        (await state.storage.list({ prefix: "usage-outbox:" })).size,
    ),
  ).toBe(0);
  const closed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await closed;
});
