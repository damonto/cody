import { setTestConfiguration } from "../helpers/worker-configuration.ts";
import {
  applyD1Migrations,
  createExecutionContext,
  runDurableObjectAlarm,
  type D1Migration,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  clearConfigCacheForTests,
  parseConfig,
} from "../../src/config/store.ts";
import { gatewayApp as worker } from "../../src/gateway/app.ts";
import { RequestMeter } from "../../src/telemetry/meter.ts";
import {
  getCredentialAvailability,
  recordCredentialQuotaCooldown,
} from "../../src/gateway/health/health.ts";
import { ProviderHealthCore } from "../../src/gateway/health/provider-health.ts";
import { SessionAffinityCore } from "../../src/gateway/sessions/session-affinity.ts";
import {
  accountReply,
  accountViewSchema,
  sessionViewSchema,
} from "../../src/providers/oauth/schema.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const actor = "admin@example.test";
const MODEL = "gpt-5.5-codex";
const FIRST_FRAME = JSON.stringify({
  type: "response.create",
  model: MODEL,
  reasoning: { effort: "high" },
  input: [{ role: "user", content: "hello" }],
});

interface UpstreamMessage {
  kind: "text" | "binary";
  data: string | number[];
}
/** How the Codex upstream answers one ChatGPT workspace account's handshake. */
type Handshake = { exhausted: number } | { connection: string };

const handshakes = new Map<string, Handshake>();
const upgrades: string[] = [];

function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function testUpstream(): Fetcher {
  return Reflect.get(env, "TEST_UPSTREAM") as Fetcher;
}
function control(connection: string, path: string) {
  const url = new URL(`https://test-upstream${path}`);
  url.searchParams.set("connection_id", connection);
  return url;
}
const usageLimit = (seconds: number) => ({
  type: "usage_limit_reached",
  message: "The usage limit has been reached",
  resets_in_seconds: seconds,
});

async function send(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "backup.example") {
    upgrades.push("backup");
    return new Response("unexpected fallback", { status: 503 });
  }
  if (url.href === "https://auth.openai.com/oauth/token") {
    const code =
      new URLSearchParams(
        new TextDecoder().decode(await request.arrayBuffer()),
      ).get("code") ?? "refreshed";
    return Response.json({
      access_token: `access-${code}`,
      refresh_token: `refresh-${code}`,
      id_token: jwt({
        email: `${code}@example.test`,
        "https://api.openai.com/auth": {
          chatgpt_account_id: `acct-${code}`,
          chatgpt_plan_type: "plus",
        },
      }),
      expires_in: 3600,
    });
  }
  if (url.pathname === "/backend-api/codex/responses") {
    const account = request.headers.get("chatgpt-account-id") ?? "";
    upgrades.push(account);
    const handshake = handshakes.get(account);
    if (!handshake) throw new Error(`No handshake for ${account}`);
    if ("exhausted" in handshake)
      return Response.json(
        { error: usageLimit(handshake.exhausted) },
        { status: 429 },
      );
    return testUpstream().fetch(
      new Request(control(handshake.connection, "/responses"), {
        headers: { upgrade: "websocket" },
      }),
    );
  }
  return new Response("not found", { status: 404 });
}

beforeAll(() => applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS));
beforeEach(() => {
  handshakes.clear();
  upgrades.length = 0;
  clearConfigCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      send(input instanceof Request ? input : new Request(input, init)),
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A ready account whose workspace ID is `acct-<credential ID>`. */
async function ready(credentialId: string) {
  const ref = crypto.randomUUID();
  const stub = env.PROVIDER_OAUTH_ACCOUNT.getByName(ref);
  const session = await accountReply(
    stub.run({
      action: "start",
      actor,
      account_ref: ref,
      connection: { provider_id: "codex", credential_id: credentialId },
      provider_type: "codex",
      flow: "pkce",
    }),
    sessionViewSchema,
  );
  const state = new URL(session.url!).searchParams.get("state")!;
  await accountReply(
    stub.run({
      action: "complete",
      actor,
      session_id: session.id.split(".")[1],
      redirect_url: `http://localhost:1455/auth/callback?${new URLSearchParams({ state, code: credentialId })}`,
    }),
    sessionViewSchema,
  );
  for (let i = 0; i < 7; i++) {
    await runDurableObjectAlarm(stub);
    const view = await accountReply(
      stub.run({ action: "view" }),
      accountViewSchema,
    );
    if (view.status === "ready")
      return { id: credentialId, ref, account: `acct-${credentialId}` };
  }
  throw new Error("Account did not become ready");
}

/** Two ready accounts under a session-affinity Codex, so the first is tried first. */
async function pool(backup = false) {
  const prefix = crypto.randomUUID().slice(0, 8);
  const accounts = await Promise.all([
    ready(`${prefix}-0`),
    ready(`${prefix}-1`),
  ]);
  const config = parseConfig({
    providers: [
      {
        type: "codex",
        id: "codex",
        models: [MODEL],
        priority: 100,
        disabled: false,
        account_selection: "session_affinity",
        credentials: accounts.map(({ id, ref }) => ({
          id,
          priority: 100,
          disabled: false,
          auth: { type: "oauth", account_ref: ref },
        })),
      },
      ...(backup
        ? [
            {
              type: "ai_gateway",
              id: "backup",
              base_url: "https://backup.example/v1",
              priority: 50,
              disabled: false,
              supports_websocket: true,
              models: [MODEL],
              credentials: [
                {
                  id: "backup-key",
                  priority: 100,
                  disabled: false,
                  auth: { type: "api_key", api_key: "mock-backup" },
                },
              ],
            },
          ]
        : []),
    ],
    api_keys: [
      {
        id: "client",
        api_key: "client-secret",
        providers: backup ? ["codex", "backup"] : ["codex"],
      },
    ],
  });
  await setTestConfiguration(
    env.CODY_DB,
    "gateway-config",
    JSON.stringify(config),
  );
  return accounts;
}

async function openGatewaySocket(
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  const response = await worker.fetch(
    new Request("https://gateway.example/v1/responses", {
      headers: {
        authorization: "Bearer client-secret",
        connection: "Upgrade",
        upgrade: "websocket",
        ...headers,
      },
    }),
    env,
    createExecutionContext(),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`timed out waiting for ${label}`)),
        2_000,
      ),
    ),
  ]);
}
/** Every client message, in arrival order. */
function received(socket: WebSocket) {
  const messages: string[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
  });
  return messages;
}
const closed = (socket: WebSocket) =>
  within(
    new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    ),
    "client close",
  );
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function upstreamMessages(connection: string): Promise<string[]> {
  const response = await testUpstream().fetch(
    new Request(control(connection, "/__test/messages")),
  );
  if (response.status === 404) return [];
  const { messages } = await response.json<{ messages: UpstreamMessage[] }>();
  return messages.map((message) => String(message.data));
}
async function nextUpstreamMessage(connection: string) {
  let messages: string[] = [];
  const deadline = Date.now() + 2_000;
  while (!messages.length && Date.now() < deadline) {
    messages = await upstreamMessages(connection);
    if (!messages.length)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!messages.length)
    throw new Error("timed out waiting for upstream message");
  return messages[0];
}
const sendUpstream = (connection: string, message: unknown) =>
  testUpstream().fetch(
    new Request(control(connection, "/__test/send"), {
      method: "POST",
      body: JSON.stringify(message),
    }),
  );

async function expectQuotaCooldown(credentialId: string, seconds: number) {
  const health = await getCredentialAvailability(env, "codex", credentialId);
  expect(health).toMatchObject({ available: false, cooldown_reason: "quota" });
  expect(health.cooling_until).toBeGreaterThan(
    Date.now() + (seconds - 5) * 1000,
  );
}

test("an exhausted account's handshake moves the connection to the next account", async () => {
  const [first, second] = await pool();
  const connection = crypto.randomUUID();
  handshakes.set(first.account, { exhausted: 600 });
  handshakes.set(second.account, { connection });
  const socket = await openGatewaySocket();
  const messages = received(socket);
  socket.send(FIRST_FRAME);
  expect(await nextUpstreamMessage(connection)).toBe(FIRST_FRAME);
  expect(upgrades).toEqual([first.account, second.account]);
  await expectQuotaCooldown(first.id, 600);

  const completed = { type: "response.completed", response: { id: "resp" } };
  await sendUpstream(connection, completed);
  await until(() => messages.length > 0, "client message");
  expect(messages.map((message) => JSON.parse(message))).toEqual([completed]);
  socket.close(1000, "done");
});

test("a usage-limit error before any output resends the first frame on another account", async () => {
  const metering = vi.spyOn(RequestMeter.prototype, "observeUpstream");
  const [first, second] = await pool();
  const [exhausted, fresh] = [crypto.randomUUID(), crypto.randomUUID()];
  handshakes.set(first.account, { connection: exhausted });
  handshakes.set(second.account, { connection: fresh });
  const socket = await openGatewaySocket();
  const messages = received(socket);
  socket.send(FIRST_FRAME);
  expect(await nextUpstreamMessage(exhausted)).toBe(FIRST_FRAME);

  await sendUpstream(exhausted, {
    type: "error",
    status: 429,
    error: usageLimit(300),
    model: "exhausted-model",
    reasoning: { effort: "low" },
  });
  expect(await nextUpstreamMessage(fresh)).toBe(FIRST_FRAME);
  expect(upgrades).toEqual([first.account, second.account]);
  await expectQuotaCooldown(first.id, 300);

  const created = {
    type: "response.created",
    response: {
      id: "resp",
      model: `${MODEL}-version`,
      reasoning: { effort: "high" },
    },
  };
  await sendUpstream(fresh, created);
  await until(() => messages.length > 0, "client message");
  // The exhausted account's error never reaches the client.
  expect(messages.map((message) => JSON.parse(message))).toEqual([created]);
  const meter = metering.mock.contexts[0];
  if (!(meter instanceof RequestMeter))
    throw new Error("Missing request meter");
  expect(meter.checkpoint()).toMatchObject({
    credential_id: second.id,
    upstream_observation: {
      request: { model: MODEL, reasoning: { effort: "high" } },
      response: { model: `${MODEL}-version`, reasoning: { effort: "high" } },
    },
  });
  socket.close(1000, "done");
});

test("once output has started the usage-limit error is forwarded and the account cools", async () => {
  const [first, second] = await pool();
  const connection = crypto.randomUUID();
  handshakes.set(first.account, { connection });
  handshakes.set(second.account, { connection: crypto.randomUUID() });
  const socket = await openGatewaySocket();
  const messages = received(socket);
  const close = closed(socket);
  socket.send(FIRST_FRAME);
  expect(await nextUpstreamMessage(connection)).toBe(FIRST_FRAME);

  const created = { type: "response.created", response: { id: "resp" } };
  await sendUpstream(connection, created);
  await until(() => messages.length > 0, "client message");
  const error = { type: "error", status: 429, error: usageLimit(900) };
  await sendUpstream(connection, error);
  expect((await close).code).toBe(1011);
  expect(messages.map((message) => JSON.parse(message))).toEqual([
    created,
    error,
  ]);
  expect(upgrades).toEqual([first.account]);
  await expectQuotaCooldown(first.id, 900);
});

test("when every account's handshake is exhausted the client receives a usage-limit event", async () => {
  const [first, second] = await pool(true);
  handshakes.set(first.account, { exhausted: 600 });
  handshakes.set(second.account, { exhausted: 120 });
  const socket = await openGatewaySocket();
  const messages = received(socket);
  const close = closed(socket);
  socket.send(FIRST_FRAME);
  expect((await close).code).toBe(1013);
  expect(upgrades).toEqual([first.account, second.account]);
  expect(messages).toHaveLength(1);
  expect(JSON.parse(messages[0])).toMatchObject({
    type: "error",
    status: 429,
    error: { type: "usage_limit_reached" },
  });
  await expectQuotaCooldown(second.id, 120);
});

test("a first-frame quota error keeps fallback within the selected provider", async () => {
  const [first, second] = await pool(true);
  const connection = crypto.randomUUID();
  handshakes.set(first.account, { connection });
  handshakes.set(second.account, { exhausted: 120 });
  const socket = await openGatewaySocket();
  const close = closed(socket);
  const messages = received(socket);
  socket.send(FIRST_FRAME);
  await nextUpstreamMessage(connection);
  await sendUpstream(connection, {
    type: "error",
    status: 429,
    error: usageLimit(300),
  });
  expect((await close).code).toBe(1013);
  expect(upgrades).toEqual([first.account, second.account]);
  expect(JSON.parse(messages[0])).toMatchObject({ type: "error", status: 429 });
});

test.each(["handshake", "frame"])(
  "a failed quota write stops WebSocket switching after a %s error",
  async (mode) => {
    const [first, second] = await pool();
    const connection = crypto.randomUUID();
    handshakes.set(
      first.account,
      mode === "handshake" ? { exhausted: 600 } : { connection },
    );
    handshakes.set(second.account, { connection: crypto.randomUUID() });
    vi.spyOn(
      ProviderHealthCore.prototype,
      "recordCooldownUntil",
    ).mockRejectedValue(new Error("mock quota storage failure"));
    const socket = await openGatewaySocket();
    const messages = received(socket);
    const close = closed(socket);
    socket.send(FIRST_FRAME);
    if (mode === "frame") {
      await nextUpstreamMessage(connection);
      await sendUpstream(connection, {
        type: "error",
        status: 429,
        error: usageLimit(600),
      });
    }
    expect((await close).code).toBe(1013);
    expect(upgrades).toEqual([first.account]);
    expect(JSON.parse(messages[0])).toMatchObject({
      type: "error",
      status: 429,
    });
  },
);

test.each([false, true])(
  "response.failed quota errors switch only before output (output started: %s)",
  async (outputStarted) => {
    const [first, second] = await pool();
    const [connection, fresh] = [crypto.randomUUID(), crypto.randomUUID()];
    handshakes.set(first.account, { connection });
    handshakes.set(second.account, { connection: fresh });
    const socket = await openGatewaySocket();
    const messages = received(socket);
    socket.send(FIRST_FRAME);
    await nextUpstreamMessage(connection);
    const output = { type: "response.output_text.delta", delta: "partial" };
    if (outputStarted) {
      await sendUpstream(connection, output);
      await until(() => messages.length > 0, "output");
    }
    const close = outputStarted ? closed(socket) : undefined;
    const error = {
      type: "response.failed",
      response: {
        id: "resp-quota",
        status: "failed",
        error: { code: "usage_not_included", resets_in_seconds: 600 },
      },
    };
    await sendUpstream(connection, error);
    if (close) {
      expect((await close).code).toBe(1011);
      expect(upgrades).toEqual([first.account]);
      expect(messages.map((message) => JSON.parse(message))).toEqual([
        output,
        error,
      ]);
    } else {
      expect(await nextUpstreamMessage(fresh)).toBe(FIRST_FRAME);
      expect(upgrades).toEqual([first.account, second.account]);
      expect(messages).toEqual([]);
      socket.close(1000, "done");
    }
    await expectQuotaCooldown(first.id, 600);
  },
);

test.each(["error", "error-with-status", "response.failed"])(
  "a later %s quota rejection requests full replay and reconnects on another account",
  async (kind) => {
    const [first, second] = await pool();
    const [oldConnection, freshConnection] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    handshakes.set(first.account, { connection: oldConnection });
    handshakes.set(second.account, { connection: freshConnection });
    const headers = { "session-id": crypto.randomUUID() };
    const socket = await openGatewaySocket(headers);
    const messages = received(socket);
    const close = closed(socket);
    socket.send(FIRST_FRAME);
    await nextUpstreamMessage(oldConnection);
    const output = {
      type: "message",
      role: "assistant",
      content: "hello back",
    };
    await sendUpstream(oldConnection, {
      type: "response.completed",
      response: { id: "first-response", output: [output] },
    });
    await until(() => messages.length === 1, "completed first turn");
    const followup = { role: "user", content: "continue" };
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: MODEL,
        previous_response_id: "first-response",
        input: [followup],
      }),
    );
    await nextUpstreamMessage(oldConnection);
    await sendUpstream(
      oldConnection,
      kind === "response.failed"
        ? { type: kind, response: { error: usageLimit(600) } }
        : {
            type: "error",
            ...(kind === "error-with-status" ? { status: 429 } : {}),
            error: usageLimit(600),
          },
    );
    expect((await close).code).toBe(1012);
    expect(JSON.parse(messages.at(-1)!)).toMatchObject({
      type: "error",
      error: { code: "previous_response_not_found" },
    });
    expect(upgrades).toEqual([first.account]);
    await expectQuotaCooldown(first.id, 600);
    const replay = await openGatewaySocket(headers);
    const fullInput = {
      ...JSON.parse(FIRST_FRAME),
      input: [{ role: "user", content: "hello" }, output, followup],
    };
    replay.send(JSON.stringify(fullInput));
    expect(JSON.parse(await nextUpstreamMessage(freshConnection))).toEqual(
      fullInput,
    );
    expect(upgrades).toEqual([first.account, second.account]);
    replay.close(1000, "done");
  },
);

test.each(["output", "overlap", "quota-write", "inline-output"])(
  "a later quota rejection does not request replay after %s",
  async (guard) => {
    const [first, second] = await pool();
    const connection = crypto.randomUUID();
    handshakes.set(first.account, { connection });
    handshakes.set(second.account, { connection: crypto.randomUUID() });
    const socket = await openGatewaySocket();
    const messages = received(socket);
    const close = closed(socket);
    socket.send(FIRST_FRAME);
    await nextUpstreamMessage(connection);
    const completed = {
      type: "response.completed",
      response: { id: "first-response" },
    };
    await sendUpstream(connection, completed);
    await until(() => messages.length === 1, "completed first turn");
    const followup = JSON.stringify({
      ...JSON.parse(FIRST_FRAME),
      previous_response_id: "first-response",
    });
    socket.send(followup);
    await nextUpstreamMessage(connection);
    const expected: unknown[] = [completed];
    if (guard === "output") {
      const delta = { type: "response.output_text.delta", delta: "partial" };
      await sendUpstream(connection, delta);
      await until(() => messages.length === 2, "later output");
      expected.push(delta);
    }
    if (guard === "overlap") {
      socket.send(followup);
      await nextUpstreamMessage(connection);
    }
    if (guard === "quota-write") {
      vi.spyOn(
        ProviderHealthCore.prototype,
        "recordCooldownUntil",
      ).mockRejectedValue(new Error("mock quota storage failure"));
    }
    const error = {
      type: "error",
      status: 429,
      error: usageLimit(600),
      ...(guard === "inline-output"
        ? { output: [{ type: "message", content: "partial" }] }
        : {}),
    };
    await sendUpstream(connection, error);
    expect((await close).code).toBe(1011);
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      ...expected,
      error,
    ]);
    expect(upgrades).toEqual([first.account]);
    if (guard !== "quota-write") await expectQuotaCooldown(first.id, 600);
  },
);

test("a fresh Codex connection rejects a stale response ID before sending delta input", async () => {
  await pool();
  const socket = await openGatewaySocket();
  const messages = received(socket);
  const close = closed(socket);
  socket.send(
    JSON.stringify({
      ...JSON.parse(FIRST_FRAME),
      previous_response_id: "old-account-response",
    }),
  );
  expect((await close).code).toBe(1012);
  expect(JSON.parse(messages[0])).toMatchObject({
    error: { code: "previous_response_not_found" },
  });
  expect(upgrades).toEqual([]);
});

test("one completed response cannot make overlapping turns safe to replay", async () => {
  const [first, second] = await pool();
  const connection = crypto.randomUUID();
  handshakes.set(first.account, { connection });
  handshakes.set(second.account, { connection: crypto.randomUUID() });
  const socket = await openGatewaySocket();
  const messages = received(socket);
  const close = closed(socket);
  socket.send(FIRST_FRAME);
  await nextUpstreamMessage(connection);
  socket.send(FIRST_FRAME);
  await nextUpstreamMessage(connection);
  const completed = {
    type: "response.completed",
    response: { id: "first-response" },
  };
  await sendUpstream(connection, completed);
  await until(() => messages.length === 1, "first completion");
  // The second turn is still pending when a third request arrives.
  socket.send(FIRST_FRAME);
  await nextUpstreamMessage(connection);
  const error = { type: "error", status: 429, error: usageLimit(600) };
  await sendUpstream(connection, error);
  expect((await close).code).toBe(1011);
  expect(messages.map((message) => JSON.parse(message))).toEqual([
    completed,
    error,
  ]);
  expect(upgrades).toEqual([first.account]);
  await expectQuotaCooldown(first.id, 600);
});

test.each(["cooldown", "storage-failure"])(
  "later route validation distinguishes %s from an unavailable continuation",
  async (failure) => {
    const [first, second] = await pool();
    const connection = crypto.randomUUID();
    handshakes.set(first.account, { connection });
    handshakes.set(second.account, { connection: crypto.randomUUID() });
    const socket = await openGatewaySocket({
      "session-id": crypto.randomUUID(),
    });
    const messages = received(socket);
    const close = closed(socket);
    socket.send(FIRST_FRAME);
    await nextUpstreamMessage(connection);
    await sendUpstream(connection, {
      type: "response.completed",
      response: { id: "first-response" },
    });
    await until(() => messages.length === 1, "first completion");
    if (failure === "cooldown") {
      await recordCredentialQuotaCooldown(
        env,
        "codex",
        first.id,
        Date.now() + 600_000,
      );
    } else {
      vi.spyOn(SessionAffinityCore.prototype, "resolve").mockRejectedValue(
        new Error("mock affinity storage failure"),
      );
    }
    socket.send(
      JSON.stringify({
        ...JSON.parse(FIRST_FRAME),
        previous_response_id: "first-response",
      }),
    );
    expect((await close).code).toBe(1012);
    expect(JSON.parse(messages.at(-1)!)).toMatchObject({
      type: "error",
      status: failure === "cooldown" ? 409 : 503,
      error: {
        code:
          failure === "cooldown"
            ? "previous_response_not_found"
            : "session_affinity_unavailable",
      },
    });
    expect(await upstreamMessages(connection)).toEqual([]);
    expect(upgrades).toEqual([first.account]);
  },
);
