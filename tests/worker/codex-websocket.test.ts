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
import { getCredentialAvailability } from "../../src/gateway/health/health.ts";
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
async function pool() {
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
    ],
    api_keys: [
      { id: "client", api_key: "client-secret", providers: ["codex"] },
    ],
  });
  await setTestConfiguration(
    env.CODY_DB,
    "gateway-config",
    JSON.stringify(config),
  );
  return accounts;
}

async function openGatewaySocket(): Promise<WebSocket> {
  const response = await worker.fetch(
    new Request("https://gateway.example/v1/responses", {
      headers: {
        authorization: "Bearer client-secret",
        connection: "Upgrade",
        upgrade: "websocket",
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
  const [first, second] = await pool();
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
    error: { type: "usage_limit_reached" },
  });
  await expectQuotaCooldown(second.id, 120);
});
