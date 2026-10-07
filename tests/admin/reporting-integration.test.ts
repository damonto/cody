import { RequestMeter } from "../../src/telemetry/meter.ts";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import adminWorker, { app } from "../../src/worker.ts";
import { clearConfigCacheForTests } from "../../src/config/store.ts";
import { ControlStore } from "../../src/control/store.ts";
import { decryptConfig, encryptConfig } from "../../src/control/crypto.ts";
import { authenticateAdmin, safeAdminMutation } from "../../src/admin/auth.ts";
import {
  cleanupRequests,
  ingestUsage,
  requestDetail,
  requestList,
  summary,
} from "../../src/reporting/store.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";
import { emptyUsage } from "../../src/telemetry/usage.ts";
import { emptyCost } from "../../src/billing/calculate.ts";
import { config, usage } from "./fixtures.ts";
const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const control = () =>
  new ControlStore(bindings.CODY_DB, bindings.CONFIG_ENCRYPTION_KEY);
const range = (from: number, to: number) => ({
  from,
  to,
  time_zone: "UTC",
  period: "day" as const,
});
const call = (
  path: string,
  method = "GET",
  value?: unknown,
  headers?: Record<string, string>,
) =>
  app.request(
    `http://localhost${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-cody-admin": "1",
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    },
    bindings,
    createExecutionContext(),
  );
const saveConfig = () => control().save(config(), 0, "tester");
beforeAll(() => applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  clearConfigCacheForTests();
  const tables = [
    "request_attempts",
    "requests",
    "usage_hourly",
    "model_price_versions",
    "config_operations",
    "config_snapshots",
    "model_route_providers",
    "model_routes",
    "model_prices",
    "provider_models",
    "client_providers",
    "provider_credentials",
    "proxy_nodes",
    "clients",
    "providers",
    "proxy_groups",
    "settings",
    "secret_versions",
    "audit_log",
  ];
  await bindings.CODY_DB.batch(
    tables.map((table) => bindings.CODY_DB.prepare(`DELETE FROM ${table}`)),
  );
  await bindings.CODY_DB.prepare(
    "UPDATE config_meta SET version=0,maintenance=0,operation_id=NULL,updated_at=0 WHERE id=1",
  ).run();
});
test("AES-GCM authenticates payloads and key material", async () => {
  const encrypted = await encryptConfig(
    config(),
    bindings.CONFIG_ENCRYPTION_KEY,
  );
  expect(
    await decryptConfig(encrypted, bindings.CONFIG_ENCRYPTION_KEY),
  ).toEqual(config());
  const envelope = JSON.parse(encrypted) as { data: string };
  envelope.data = `${envelope.data[0] === "A" ? "B" : "A"}${envelope.data.slice(1)}`;
  await expect(
    decryptConfig(JSON.stringify(envelope), bindings.CONFIG_ENCRYPTION_KEY),
  ).rejects.toThrow();
  await expect(encryptConfig({}, "invalid-key")).rejects.toThrow("32-byte key");
});

test("duplicate and out-of-order usage events aggregate exactly once", async () => {
  const event = usage("request-a", Date.UTC(2026, 8, 12, 3, 10));
  const start: UsageEvent = {
    ...event,
    phase: "started",
    sequence: 0,
    finished_at: null,
    outcome: "pending",
    usage: { tokens: emptyUsage(), raw: {}, status: "missing" },
    billing: emptyCost(),
    attempts: [],
  };
  await ingestUsage(bindings.CODY_DB, event);
  await ingestUsage(bindings.CODY_DB, event);
  await ingestUsage(bindings.CODY_DB, start);
  await ingestUsage(bindings.CODY_DB, { ...start, sequence: 1 });
  expect(await requestDetail(bindings.CODY_DB, event.request_id)).toEqual(
    event,
  );
  const result = await summary(
    bindings.CODY_DB,
    range(event.started_at - 1, event.started_at + 10_000),
    {},
  );
  expect(result.totals.requests_count).toBe(1);
  expect(result.totals.input_tokens).toBe(1000);
  expect(result.currencies.USD?.cost_nano).toBe(event.billing.total_nano);
  expect(result.totals.reasoning_tokens).toBe(25);
  expect(
    (
      await bindings.CODY_DB.prepare(
        "SELECT COUNT(*) AS total FROM request_attempts",
      ).first<{ total: number }>()
    )?.total,
  ).toBe(1);
  expect(JSON.stringify(event)).not.toContain("private completion content");
});

test("selection updates pending routing and terminal transition adds one aggregate", async () => {
  const event = usage("request-pending", Date.now() - 10_000);
  const start: UsageEvent = {
    ...event,
    phase: "started",
    sequence: 0,
    provider_id: "",
    model: "",
    finished_at: null,
    outcome: "pending",
    billing: emptyCost(),
    attempts: [],
  };
  await ingestUsage(bindings.CODY_DB, start);
  await ingestUsage(bindings.CODY_DB, {
    ...start,
    sequence: 1,
    provider_id: event.provider_id,
    model: event.model,
  });
  const window = range(event.started_at - 1, Date.now());
  expect(
    (await summary(bindings.CODY_DB, window, { provider_id: "provider" }))
      .pending,
  ).toBe(1);
  await ingestUsage(bindings.CODY_DB, event);
  const totals = await summary(bindings.CODY_DB, window, {
    provider_id: "provider",
  });
  expect(totals.pending).toBe(0);
  expect(totals.totals.requests_count).toBe(1);
});

test("reports combine full hours with precise boundaries and never sum currencies", async () => {
  const base = Date.UTC(2026, 8, 11);
  for (const [index, minute] of [29, 31, 90, 139, 141].entries()) {
    await ingestUsage(
      bindings.CODY_DB,
      usage(
        `edge-${index}`,
        base + minute * 60_000,
        index === 2 ? "EUR" : "USD",
      ),
    );
  }
  const result = await summary(
    bindings.CODY_DB,
    range(base + 30 * 60_000, base + 140 * 60_000),
    { client_id: "client" },
  );
  expect(result.totals.requests_count).toBe(3);
  expect(result.totals.cost_nano).toBe(0);
  expect(Object.keys(result.currencies).sort()).toEqual(["EUR", "USD"]);
  expect(result.currencies.USD!.cost_nano).toBe(
    result.currencies.EUR!.cost_nano * 2,
  );
  expect(
    (
      await summary(bindings.CODY_DB, range(base, base + 86400000), {
        provider_id: "other",
      })
    ).totals.requests_count,
  ).toBe(0);
});

test("total reports include older history and preserve costs after request retention", async () => {
  const now = Date.UTC(2026, 8, 12, 4, 30);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const historical = usage("historical", Date.UTC(2024, 0, 10, 12));
  const recent = usage("recent", now - 60_000);
  for (const event of [
    historical,
    recent,
    { ...usage("other-provider", now - 60_000), provider_id: "other" },
    usage("future", now + 60_000),
  ]) {
    await ingestUsage(bindings.CODY_DB, event);
  }
  const query = "period=total&provider_id=provider&time_zone=UTC";
  const response = await call(`/console/api/summary?${query}`);
  expect(response.status).toBe(200);
  const before = (await response.json()) as Awaited<ReturnType<typeof summary>>;
  expect(before.range).toMatchObject({ period: "total", from: 0, to: now });
  expect(before.totals).toMatchObject({
    requests_count: 2,
    input_tokens: 2000,
    output_tokens: 200,
  });
  expect(before.currencies.USD?.cost_nano).toBe(
    historical.billing.total_nano! + recent.billing.total_nano!,
  );

  await cleanupRequests(bindings.CODY_DB, 120);
  expect(
    await requestDetail(bindings.CODY_DB, historical.request_id),
  ).toBeNull();
  const after = await call(`/console/api/summary?${query}`);
  expect(await after.json()).toEqual(before);

  const retained = await call(`/console/api/requests?${query}`);
  expect(retained.status).toBe(200);
  const page = (await retained.json()) as Awaited<
    ReturnType<typeof requestList>
  >;
  expect(page.items.map((item) => item.request_id)).toEqual([
    recent.request_id,
  ]);
});

test("request pages omit auxiliary endpoints before pagination", async () => {
  const at = Date.now() - 10_000;
  for (const event of [
    usage("response-old", at),
    {
      ...usage("message", at + 1),
      endpoint: "messages",
      protocol: "anthropic" as const,
    },
    usage("response-new", at + 2),
  ]) {
    await ingestUsage(bindings.CODY_DB, event);
  }
  const hidden = [
    "responses/compact",
    "messages/count_tokens",
    "alpha/search",
  ] as const;
  for (const [index, endpoint] of hidden.entries()) {
    await ingestUsage(bindings.CODY_DB, {
      ...usage(`hidden-${index}`, at + 3 + index),
      endpoint,
    });
  }
  const response = await call("/console/api/requests?period=total&limit=2");
  expect(response.status).toBe(200);
  const first = (await response.json()) as Awaited<
    ReturnType<typeof requestList>
  >;
  expect(first.items.map((item) => item.request_id)).toEqual([
    "response-new",
    "message",
  ]);
  expect(first.next_cursor).not.toBeNull();
  const next = await call(
    `/console/api/requests?period=total&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`,
  );
  expect(next.status).toBe(200);
  const second = (await next.json()) as Awaited<ReturnType<typeof requestList>>;
  expect(second.items.map((item) => item.request_id)).toEqual(["response-old"]);
  expect(second.next_cursor).toBeNull();
});

test("request APIs preserve upstream observations and leave historical metadata absent", async () => {
  const observed = usage("upstream-observed", Date.now() - 10_000);
  observed.attempts[0].retry_diagnostic = {
    reason: "output_observed",
    event_type: "response.output_text.delta",
  };
  observed.upstream_observation = {
    request: {
      model: "real-model",
      reasoning: { effort: "high", mode: "adaptive" },
    },
    response: { model: "real-model-v2", reasoning: { effort: "low" } },
  };
  const historical = usage("upstream-historical", Date.now() - 20_000);
  await ingestUsage(bindings.CODY_DB, observed);
  await ingestUsage(bindings.CODY_DB, historical);
  const detail = await call("/console/api/requests/upstream-observed");
  expect(await detail.json()).toEqual(observed);
  const listing = await call("/console/api/requests?period=total");
  expect(await listing.json()).toMatchObject({ items: [observed, historical] });
  const old = await call("/console/api/requests/upstream-historical");
  const oldEvent = await old.json();
  expect(oldEvent).not.toHaveProperty("upstream_observation");
  expect(oldEvent).not.toHaveProperty("attempts.0.retry_diagnostic");
});

test("request reports always select inference regardless of removed kind filters", async () => {
  const at = Date.now() - 10_000;
  const options = {
    endpoint: "responses" as const,
    protocol: "openai" as const,
    sink: { send: async () => {} },
  };
  const websocket: UsageEvent = {
    ...usage("websocket-inference", at + 1),
    connection_id: "websocket-connection",
    method: "WS",
    transport: "websocket",
  };
  const rejected = new RequestMeter({
    ...options,
    requestId: "unrouted-inference",
    method: "POST",
    now: () => at + 2,
  }).finish("failed", 400);
  for (const event of [websocket, rejected])
    await ingestUsage(bindings.CODY_DB, event);

  const inferenceIds = [rejected.request_id, websocket.request_id];
  for (const kind of [
    "",
    "inference",
    "handshake",
    "catalog",
    "auxiliary",
    "all",
  ]) {
    const response = await call(
      `/console/api/requests?period=total${kind ? `&kind=${kind}` : ""}`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as Awaited<
      ReturnType<typeof requestList>
    >;
    expect(page.items.map((item) => item.request_id)).toEqual(inferenceIds);
  }
  const overview = await call("/console/api/summary?period=total");
  expect((await overview.json<{ totals: unknown }>()).totals).toMatchObject({
    requests_count: 2,
    success_count: 1,
    failed_count: 1,
  });
  const all = await call("/console/api/summary?period=total&kind=all");
  expect((await all.json<{ totals: unknown }>()).totals).toMatchObject({
    requests_count: 2,
  });
});

test("request cursors have stable ordering for equal timestamps and retention keeps aggregates", async () => {
  const at = Date.now() - 200 * 86400000;
  for (const id of ["a", "b", "c"])
    await ingestUsage(bindings.CODY_DB, usage(id, at));
  const window = range(
    Math.floor(at / 3600000) * 3600000,
    Math.floor(at / 3600000) * 3600000 + 3600000,
  );
  const first = await requestList(bindings.CODY_DB, window, {}, { limit: 2 });
  expect(first.items.map((item) => item.request_id)).toEqual(["c", "b"]);
  const second = await requestList(
    bindings.CODY_DB,
    window,
    {},
    { limit: 2, cursor: first.next_cursor! },
  );
  expect(second.items.map((item) => item.request_id)).toEqual(["a"]);
  expect(second.next_cursor).toBeNull();
  await expect(
    requestList(bindings.CODY_DB, window, {}, { limit: 2, cursor: "invalid" }),
  ).rejects.toThrow("Invalid cursor");
  await cleanupRequests(bindings.CODY_DB, 120);
  expect(await requestDetail(bindings.CODY_DB, "a")).toBeNull();
  expect(
    (await summary(bindings.CODY_DB, window, {})).totals.requests_count,
  ).toBe(3);
});

test("queue consumer ignores non-inference, commits inference, and retries invalid inference", async () => {
  const event = usage("queued", Date.now() - 10000);
  const ignored = ["auxiliary", "catalog", "handshake"].map((kind) => ({
    ...event,
    request_id: `ignored-${kind}`,
    kind,
  }));
  const batch = createMessageBatch<unknown>("cody-usage", [
    ...ignored.map((body) => ({
      id: body.request_id,
      timestamp: new Date(),
      attempts: 1,
      // Queue payloads can predate the current event type.
      body,
    })),
    { id: "valid", timestamp: new Date(), attempts: 1, body: event },
    {
      id: "invalid",
      timestamp: new Date(),
      attempts: 1,
      body: { ...event, schema_version: 99 },
    },
  ]);
  const ctx = createExecutionContext();
  await adminWorker.queue(batch, bindings);
  const result = await getQueueResult(batch, ctx);
  expect(result.explicitAcks.sort()).toEqual([
    "ignored-auxiliary",
    "ignored-catalog",
    "ignored-handshake",
    "valid",
  ]);
  expect(result.retryMessages).toEqual([{ msgId: "invalid" }]);
  expect(await requestDetail(bindings.CODY_DB, "queued")).toEqual(event);
  for (const body of ignored)
    expect(await requestDetail(bindings.CODY_DB, body.request_id)).toBeNull();
  expect(
    await bindings.CODY_DB.prepare(
      "SELECT SUM(requests_count) AS count FROM usage_hourly",
    ).first("count"),
  ).toBe(1);
});

test("admin API enforces local scope, Access authentication, same-origin writes, and Zod validation", async () => {
  expect(
    await authenticateAdmin(new Request("https://gateway.example"), bindings),
  ).toBeNull();
  expect(
    await authenticateAdmin(new Request("http://localhost"), bindings),
  ).toBe("local-admin");
  expect(
    safeAdminMutation(
      new Request("http://localhost/console/api/config", {
        method: "PUT",
        headers: { "x-cody-admin": "1", origin: "https://evil.example" },
      }),
    ),
  ).toBe(false);
  const unauthenticated = await app.request(
    "https://gateway.example/console/api/config",
    {},
    bindings,
  );
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
  expect(
    (
      await call(
        "/console/api/config",
        "PUT",
        {},
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call("/console/api/settings/reporting", "PUT", {
        version: -1,
        reporting: {},
      })
    ).status,
  ).toBe(400);
  expect((await call("/console/api/summary?period=invalid")).status).toBe(400);
  expect((await call("/console/api/requests?limit=1000")).status).toBe(400);
  const input = {
    version: 0,
    operation_id: crypto.randomUUID(),
    reporting: { time_zone: "UTC", retention_days: 120 },
  };
  const saved = await call("/console/api/settings/reporting", "PUT", input);
  expect(saved.status).toBe(200);
  expect(
    (
      await call("/console/api/settings/reporting", "PUT", {
        ...input,
        operation_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});

test("the unified Worker separates gateway authentication from protected console routes", async () => {
  await saveConfig();
  for (const path of ["/v1/health", "/health"]) {
    const response = await app.request(
      `https://gateway.example${path}`,
      {
        headers: { authorization: "Bearer test-client-secret" },
      },
      bindings,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(await response.json()).toMatchObject({ object: "list" });
  }
  for (const path of ["/v1/unknown", "/images/unknown", "/health/invalid!"]) {
    const response = await app.request(
      `https://gateway.example${path}`,
      {},
      bindings,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  }
  const method = await app.request(
    "https://gateway.example/v1/messages",
    {},
    bindings,
    createExecutionContext(),
  );
  expect(method.status).toBe(405);
  expect(await method.json()).toMatchObject({
    type: "error",
    error: { type: "api_error" },
  });
  for (const path of [
    "/console/",
    "/console/settings",
    "/console/api/config",
    "/console/assets/console.js",
    "/console/favicon.svg",
  ]) {
    const response = await app.request(
      `https://gateway.example${path}`,
      { headers: { authorization: "Bearer test-client-secret" } },
      bindings,
      createExecutionContext(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const path of [
    "/settings",
    "/api/config",
    "/assets/console.js",
    "/console-other",
  ]) {
    const response = await call(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  }
  const page = await call("/console/settings");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect((await call("/console/api")).status).toBe(404);
  expect((await call("/console/api/unknown")).status).toBe(404);
});

test("console entry redirects preserve queries and lead into the protected prefix", async () => {
  for (const [path, status] of [
    ["/", 302],
    ["/console", 308],
  ] as const) {
    const response = await app.request(
      `https://gateway.example${path}?period=total`,
      {},
      bindings,
      createExecutionContext(),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBe("/console/?period=total");
    const protectedPage = await app.request(
      new URL(response.headers.get("location")!, "https://gateway.example")
        .href,
      {},
      bindings,
      createExecutionContext(),
    );
    expect(protectedPage.status).toBe(401);
  }
});

test("console deep links load built assets exclusively through the protected prefix", async () => {
  for (const path of ["/console/", "/console/overview", "/console/settings"]) {
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(assets.some((asset) => asset.endsWith(".js"))).toBe(true);
    expect(assets.some((asset) => asset.endsWith(".css"))).toBe(true);
    expect(assets).toContain("/console/favicon.svg");
    for (const asset of assets) {
      expect(asset).toMatch(/^\/console\//);
      const file = await call(asset);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).not.toContain("text/html");
      expect((await call(asset.slice("/console".length))).status).toBe(404);
    }
  }
  const canonical = await call("/console/index.html?period=total");
  expect([301, 302, 307, 308]).toContain(canonical.status);
  expect(canonical.headers.get("location")).toBe("/console/?period=total");
});

test("model API calls on the console hostname require only gateway client credentials", async () => {
  await saveConfig();
  const upstreamRequests: Request[] = [];
  const result = {
    id: "upstream-response",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    upstreamRequests.push(new Request(input, init));
    return Response.json(result, { headers: { "x-upstream": "preserved" } });
  });
  const cases = [
    {
      path: "/v1/responses",
      header: "authorization",
      credential: "Bearer test-client-secret",
    },
    {
      path: "/responses",
      header: "authorization",
      credential: "Bearer test-client-secret",
    },
    {
      path: "/v1/messages",
      header: "x-api-key",
      credential: "test-client-secret",
    },
  ];
  for (const { path, header, credential } of cases) {
    const context = createExecutionContext();
    const response = await app.request(
      `https://gateway.example${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", [header]: credential },
        body: JSON.stringify({
          model: "real-model",
          input: "hello",
          messages: [],
          max_tokens: 1,
        }),
      },
      bindings,
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-upstream")).toBe("preserved");
    expect(await response.json()).toEqual(result);
    await waitOnExecutionContext(context);
  }
  expect(upstreamRequests).toHaveLength(cases.length);
  expect(
    upstreamRequests.map((request) => new URL(request.url).pathname),
  ).toEqual(["/v1/responses", "/v1/responses", "/v1/messages"]);
  for (const request of upstreamRequests) {
    expect(request.headers.get("authorization")).toBe(
      "Bearer test-upstream-secret",
    );
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("cf-access-jwt-assertion")).toBeNull();
  }
});

test("image request details survive ingestion and replay without new rollup columns", async () => {
  const event = usage("image-details", Date.now() - 5000);
  event.endpoint = "images/edits";
  Object.assign(event.usage.tokens, {
    image_input_tokens: 100,
    image_output_tokens: 20,
    image_cache_read_tokens: 40,
    image_cache_write_tokens: 15,
  });
  Object.assign(event.billing, {
    image_input_nano: 1000,
    image_output_nano: 2000,
    image_cache_read_nano: 300,
    image_cache_write_nano: 500,
  });
  event.attempts[0].usage = structuredClone(event.usage);
  event.attempts[0].billing = structuredClone(event.billing);
  await ingestUsage(bindings.CODY_DB, event);
  await ingestUsage(bindings.CODY_DB, event);
  const response = await call("/console/api/requests/image-details");
  expect(response.status).toBe(200);
  const result = (await response.json()) as UsageEvent;
  expect(result.usage.tokens).toEqual(event.usage.tokens);
  expect(result.billing).toEqual(event.billing);
  expect(result.attempts[0].usage).toEqual(event.attempts[0].usage);
  const listing = await call("/console/api/requests?period=total");
  expect(
    ((await listing.json()) as { items: UsageEvent[] }).items.map(
      (item) => item.request_id,
    ),
  ).toContain(event.request_id);
});
