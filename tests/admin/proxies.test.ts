import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { app } from "../../src/worker.ts";
import { controlStore } from "../../src/admin/context.ts";
import { testProxy } from "../../src/admin/proxy-test.ts";
import { socksFetch } from "../../src/gateway/transport/socks-fetch.ts";
import { SocksProxyError } from "../../src/gateway/proxies/errors.ts";
import { config } from "./fixtures.ts";

vi.mock(
  import("../../src/gateway/transport/socks-fetch.ts"),
  async (original) => ({
    ...(await original()),
    socksFetch: vi.fn<typeof socksFetch>(),
  }),
);

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const path = "/console/api/config/proxy-groups/US/proxies/selected/test";
const selected = {
  id: "selected",
  url: "socks5://selected.test:1080",
  username: "proxy-user",
  password: "private-proxy-password",
  priority: 1,
  disabled: true,
};
const result = { ip: "203.0.113.9", country: "US" };
const call = (
  url = path,
  body: unknown = { version: 1 },
  headers: Record<string, string> = {},
) =>
  app.request(
    `http://localhost${url}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cody-admin": "1",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    bindings,
    createExecutionContext(),
  );

beforeAll(async () => {
  await applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.CODY_DB.prepare(
    "UPDATE control_state SET draft_version = 0, draft_payload = NULL, published_revision = NULL WHERE id = 1",
  ).run();
  const input = config();
  input.proxy_groups = [
    {
      id: "US",
      strategy: "priority",
      proxies: [
        { ...selected, id: "other", priority: 100, disabled: false },
        selected,
      ],
    },
    {
      id: "UK",
      strategy: "random",
      proxies: [{ ...selected, password: "other-secret" }],
    },
  ];
  await controlStore(bindings).save(input, 0, "tester");
  vi.mocked(socksFetch)
    .mockReset()
    .mockImplementation(async (_request, _proxy, options) => {
      options?.onStage?.("request");
      return Response.json(result);
    });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected direct fetch"),
  );
  vi.spyOn(bindings.PROXY_GROUP, "getByName");
  vi.spyOn(bindings.HEALTH, "getByName");
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(bindings.PROXY_GROUP.getByName).not.toHaveBeenCalled();
  expect(bindings.HEALTH.getByName).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("tests the selected unpublished, disabled draft node with its decrypted password", async () => {
  const before = await controlStore(bindings).state();
  const response = await call(
    path,
    { version: 1 },
    {
      authorization: "Bearer private-admin-token",
      cookie: "session=private-cookie",
      "x-api-key": "private-client-key",
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  expect(socksFetch).toHaveBeenCalledOnce();
  const [request, node] = vi.mocked(socksFetch).mock.calls[0];
  expect(node).toEqual(selected);
  expect(request.url).toBe("https://ipinfo.io/json");
  expect(request.method).toBe("GET");
  expect(request.redirect).toBe("manual");
  expect([...request.headers]).toEqual([["accept", "application/json"]]);
  expect(request.body).toBeNull();
  expect(await controlStore(bindings).state()).toEqual(before);
});

test("validates administrator authentication, request origin and JSON before testing", async () => {
  const denied = await app.request(
    `https://gateway.example${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-cody-admin": "1" },
      body: JSON.stringify({ version: 1 }),
    },
    bindings,
  );
  expect(denied.status).toBe(401);
  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { "x-cody-admin": "" },
  ]) {
    expect((await call(path, { version: 1 }, headers)).status).toBe(403);
  }
  expect(
    (await call(path, { version: 1 }, { "content-type": "text/plain" })).status,
  ).toBe(415);
  expect(
    (await call(path, { version: 1, url: "https://elsewhere.test" })).status,
  ).toBe(400);
  expect((await call(path, { version: -1 })).status).toBe(400);
  expect(socksFetch).not.toHaveBeenCalled();
});

test("rejects stale versions and missing draft nodes before opening a connection", async () => {
  expect((await call(path, { version: 0 })).status).toBe(409);
  expect((await call(path.replace("/US/", "/missing/"))).status).toBe(404);
  expect((await call(path.replace("/selected/", "/missing/"))).status).toBe(
    404,
  );
  expect(socksFetch).not.toHaveBeenCalled();
});

test.each([
  { ip: "2001:db8::9", country: "JP", expected: "JP" },
  { ip: "203.0.113.9", expected: null },
  { ip: "203.0.113.9", country: null, expected: null },
  { ip: "203.0.113.9", country: "not-a-country", expected: null },
])("normalizes IPinfo country data: %j", async ({ expected, ...data }) => {
  vi.mocked(socksFetch).mockResolvedValue(
    Response.json({ ...data, org: "unused" }),
  );
  const response = await call();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ip: data.ip, country: expected });
});

test.each([
  "not-json",
  JSON.stringify({ country: "US" }),
  JSON.stringify({ ip: "invalid" }),
])(
  "rejects malformed IPinfo results without disclosing the response: %s",
  async (body) => {
    vi.mocked(socksFetch).mockResolvedValue(new Response(body));
    const response = await call();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(body);
    expect(socksFetch).toHaveBeenCalledOnce();
  },
);

test.each([302, 401, 429, 503])(
  "reports IPinfo HTTP %i without redirects or retries",
  async (status) => {
    const cancel = vi.fn();
    vi.mocked(socksFetch).mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status,
        headers: {
          location: "https://elsewhere.test",
          "content-type": "text/plain",
        },
      }),
    );
    const response = await call();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: `IPinfo returned HTTP ${status}. Try again later.`,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(socksFetch).toHaveBeenCalledOnce();
  },
);

test.each([false, true])(
  "rejects oversized IPinfo bodies (declared length: %s) and releases them",
  async (declared) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024 + 1)));
      },
      cancel,
    });
    vi.mocked(socksFetch).mockResolvedValue(
      new Response(stream, {
        headers: declared ? { "content-length": String(64 * 1024 + 1) } : {},
      }),
    );
    expect((await call()).status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  },
);

test.each([
  new SocksProxyError("Authentication failed: private-proxy-password"),
  new SocksProxyError("private-proxy-password", "target"),
  new Error("DNS/TLS failed: private-proxy-password"),
])("sanitizes transport failures and makes one attempt: %s", async (error) => {
  vi.mocked(socksFetch).mockRejectedValue(error);
  const response = await call();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("private-proxy-password");
  expect(socksFetch).toHaveBeenCalledOnce();
});

test("the 15 second deadline aborts stalled connection setup", async () => {
  vi.useFakeTimers();
  vi.mocked(socksFetch).mockImplementation(
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
      }),
  );
  const pending = testProxy(selected, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(vi.mocked(socksFetch).mock.calls[0][0].signal.aborted).toBe(true);
  expect(socksFetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("the deadline also covers a stalled response body and cancels it", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.mocked(socksFetch).mockResolvedValue(
    new Response(new ReadableStream({ cancel })),
  );
  const pending = testProxy(selected, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("client cancellation aborts the SOCKS request and releases the response body", async () => {
  const client = new AbortController();
  const cancel = vi.fn();
  let markReading = () => {};
  const reading = new Promise<void>((resolve) => {
    markReading = resolve;
  });
  vi.mocked(socksFetch).mockResolvedValue(
    new Response(
      new ReadableStream({
        pull() {
          markReading();
        },
        cancel,
      }),
    ),
  );
  const pending = testProxy(selected, client.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await reading;
  client.abort();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.mocked(socksFetch).mock.calls[0][0].signal.aborted).toBe(true);
});

test("an HTTP client cancellation is not logged as a control-plane failure", async () => {
  const client = new AbortController();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  vi.mocked(socksFetch).mockImplementation(
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
        markStarted();
      }),
  );
  const pending = app.request(
    `http://localhost${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-cody-admin": "1" },
      body: JSON.stringify({ version: 1 }),
      signal: client.signal,
    },
    bindings,
    createExecutionContext(),
  );
  await started;
  client.abort(new Error("private cancellation reason"));
  const response = await pending;
  expect(response.status).toBe(499);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.json()).toEqual({ error: "Request cancelled." });
  expect(errors).not.toHaveBeenCalled();
  expect(socksFetch).toHaveBeenCalledOnce();
});

test("an already cancelled diagnostic never opens a SOCKS connection", async () => {
  const client = new AbortController();
  client.abort();
  await expect(testProxy(selected, client.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(socksFetch).not.toHaveBeenCalled();
});
