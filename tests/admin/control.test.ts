import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  evictDurableObject,
  getQueueResult,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import adminWorker, { app } from "../../src/worker.ts";
import { clearConfigCacheForTests } from "../../src/config/store.ts";
import {
  listCoolingHealth,
  recordKeyFailure,
} from "../../src/gateway/health/health.ts";
import { authenticateAdmin, safeAdminMutation } from "../../src/admin/auth.ts";
import { ControlStore, SECRET_PLACEHOLDER } from "../../src/control/store.ts";
import { decryptConfig, encryptConfig } from "../../src/control/crypto.ts";
import type {
  ConfigPublisher,
  PublisherReply,
} from "../../src/control/publisher.ts";
import {
  cleanupRequests,
  ingestUsage,
  requestDetail,
  requestList,
  summary,
} from "../../src/reporting/store.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";
import type { GatewayConfig } from "../../src/config/types.ts";
import { emptyUsage } from "../../src/telemetry/usage.ts";
import { emptyCost } from "../../src/billing/calculate.ts";
import { config, usage } from "./fixtures.ts";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: D1Migration[];
};
const publisher = () => bindings.CONFIG_PUBLISHER.getByName("configuration");
const control = () =>
  new ControlStore(
    bindings.CODY_DB,
    bindings.CODY_CONFIG_KV,
    bindings.CONFIG_ENCRYPTION_KEY,
  );
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

beforeAll(async () => {
  await applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  clearConfigCacheForTests();
  await runInDurableObject(publisher(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await bindings.CODY_DB.batch(
    [
      "request_attempts",
      "requests",
      "usage_hourly",
      "pricing_versions",
      "audit_log",
      "config_revisions",
    ].map((table) => bindings.CODY_DB.prepare(`DELETE FROM ${table}`)),
  );
  await bindings.CODY_DB.prepare(
    "UPDATE control_state SET draft_version = 0, draft_payload = NULL, published_revision = NULL, updated_at = 0 WHERE id = 1",
  ).run();
  await bindings.CODY_CONFIG_KV.delete("gateway-config");
});

async function publishConfig() {
  const saved = await control().save(config(), 0, "tester");
  const reply = JSON.parse(
    await publisher().publish(saved.version, "tester"),
  ) as PublisherReply;
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

test("encrypted drafts mask secrets, rotate by stable IDs, and reject stale writers", async () => {
  const saved = await control().save(config(), 0, "tester");
  expect(JSON.stringify(saved)).not.toContain("test-upstream-secret");
  expect(JSON.stringify(saved)).not.toContain("test-client-secret");
  expect(JSON.stringify(saved)).toContain(SECRET_PLACEHOLDER);
  const state = await control().state();
  expect(state.draft_payload).not.toContain("test-upstream-secret");
  const next = structuredClone(saved.config) as unknown as ReturnType<
    typeof config
  >;
  next.services[0].priority = 200;
  await control().save(next, 1, "tester");
  expect(
    ((await control().rawDraft()) as ReturnType<typeof config>).services[0]
      .keys[0].api_key,
  ).toBe("test-upstream-secret");
  await expect(control().save(next, 1, "stale-editor")).rejects.toThrow(
    "draft changed",
  );
  next.services[0].keys[0].id = "renamed";
  await expect(control().save(next, 2, "tester")).rejects.toThrow(
    "new credential",
  );
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

test("an audit insert failure rolls back the draft and its version", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  await bindings.CODY_DB.prepare(
    "INSERT INTO audit_log (id, created_at, actor, action) VALUES (?, 0, 'tester', 'existing')",
  )
    .bind(id)
    .run();
  const random = vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
  await expect(control().save(config(), 0, "tester")).rejects.toThrow();
  expect(await control().state()).toMatchObject({
    draft_version: 0,
    draft_payload: null,
  });
  random.mockRestore();
  expect((await control().save(config(), 0, "tester")).version).toBe(1);
});

test("concurrent draft saves audit only the writer that wins the version check", async () => {
  const results = await Promise.allSettled([
    control().save(config(), 0, "first"),
    control().save(config(), 0, "second"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect((await control().state()).draft_version).toBe(1);
  expect(
    (
      await bindings.CODY_DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'save_draft'",
      ).first<{ count: number }>()
    )?.count,
  ).toBe(1);
});

test("publication staging rolls back the marker and alarm together", async () => {
  const saved = await control().save(config(), 0, "tester");
  await runInDurableObject(
    publisher(),
    async (instance: ConfigPublisher, state) => {
      const transaction = state.storage.transaction.bind(state.storage);
      const spy = vi
        .spyOn(state.storage, "transaction")
        .mockImplementationOnce((operation) =>
          transaction(async (tx) => {
            await operation(tx);
            throw new Error("injected staging failure");
          }),
        );
      try {
        await expect(instance.publish(saved.version, "tester")).rejects.toThrow(
          "injected staging failure",
        );
      } finally {
        spy.mockRestore();
      }
      expect(await state.storage.get("pending_revision")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    },
  );
  expect((await control().state()).published_revision).toBeNull();
});

test("publishing creates immutable prices, persists across eviction, and rollback creates a new revision", async () => {
  const first = await publishConfig();
  const revision = first.published_revision!;
  expect(
    (
      await bindings.CODY_CONFIG_KV.get<ReturnType<typeof config>>(
        "gateway-config",
        "json",
      )
    )?.revision,
  ).toBe(revision);
  const next = structuredClone(first.config) as unknown as ReturnType<
    typeof config
  >;
  next.model_policies![0].pricing!.tiers[0].input = "6";
  const saved = await control().save(next, first.version, "editor");
  const second = JSON.parse(
    await publisher().publish(saved.version, "editor"),
  ) as PublisherReply;
  expect(second.ok).toBe(true);
  expect(
    (await control().revision(revision)).model_policies![0].pricing!.tiers[0]
      .input,
  ).toBe("3");
  await evictDurableObject(publisher());
  const restored = JSON.parse(
    await publisher().rollback(revision, saved.version, "tester"),
  ) as PublisherReply;
  expect(restored.ok).toBe(true);
  if (!restored.ok) return;
  expect(restored.data.published_revision).toBeGreaterThan(revision);
  expect(
    (await control().revision(restored.data.published_revision!))
      .model_policies![0].pricing!.tiers[0].input,
  ).toBe("3");
  expect(
    (
      await bindings.CODY_DB.prepare(
        "SELECT COUNT(*) AS total FROM pricing_versions",
      ).first<{ total: number }>()
    )?.total,
  ).toBe(3);
});

test("pending publication recovers after eviction without publishing a partial draft", async () => {
  const draft = await control().save(config(), 0, "tester");
  const revision = await control().createRevision(draft.version, "tester");
  await runInDurableObject(publisher(), async (_instance, state) => {
    await state.storage.put("pending_revision", revision);
  });
  await evictDurableObject(publisher());
  await publisher().getDraft();
  await runInDurableObject(publisher(), async (_instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  expect(await runDurableObjectAlarm(publisher())).toBe(true);
  expect((await control().state()).published_revision).toBe(revision);
  expect(
    (
      await bindings.CODY_CONFIG_KV.get<ReturnType<typeof config>>(
        "gateway-config",
        "json",
      )
    )?.services,
  ).toEqual(config().services);
});

test("structurally invalid drafts are rejected; incomplete references cannot be published", async () => {
  await expect(
    control().save({ services: "invalid", api_keys: [] }, 0, "tester"),
  ).rejects.toThrow();
  const input = config();
  input.api_keys[0].services = ["missing"];
  const saved = await control().save(input, 0, "tester");
  expect(saved.valid).toBe(false);
  const reply = JSON.parse(
    await publisher().publish(saved.version, "tester"),
  ) as PublisherReply;
  expect(reply.ok).toBe(false);
  expect(await bindings.CODY_CONFIG_KV.get("gateway-config")).toBeNull();
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
    service_id: "",
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
    service_id: event.service_id,
    model: event.model,
  });
  const window = range(event.started_at - 1, Date.now());
  expect(
    (await summary(bindings.CODY_DB, window, { service_id: "provider" }))
      .pending,
  ).toBe(1);
  await ingestUsage(bindings.CODY_DB, event);
  const totals = await summary(bindings.CODY_DB, window, {
    service_id: "provider",
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
    { kind: "inference", client_id: "client" },
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
        service_id: "other",
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
    { ...usage("other-service", now - 60_000), service_id: "other" },
    usage("future", now + 60_000),
  ]) {
    await ingestUsage(bindings.CODY_DB, event);
  }
  const query = "period=total&service_id=provider&time_zone=UTC";
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

test("request pages omit historical endpoints other than messages and responses before pagination", async () => {
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
    ["models", "catalog"],
    ["alpha/search", "auxiliary"],
    ["alpha/notes/v2/thread_hint", "auxiliary"],
    ["alpha/history/v2/list_windows", "auxiliary"],
    ["responses/compact", "inference"],
    ["chat/completions", "inference"],
    ["messages/count_tokens", "auxiliary"],
    ["images/generations", "inference"],
    ["health", "auxiliary"],
    ["sessions", "auxiliary"],
  ] as const;
  for (const [index, [endpoint, kind]] of hidden.entries()) {
    await ingestUsage(bindings.CODY_DB, {
      ...usage(`hidden-${index}`, at + 3 + index),
      endpoint,
      kind,
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

test("queue consumer acknowledges committed records and retries invalid messages", async () => {
  const event = usage("queued", Date.now() - 10000);
  const batch = createMessageBatch<UsageEvent>("cody-usage", [
    { id: "valid", timestamp: new Date(), attempts: 1, body: event },
    {
      id: "invalid",
      timestamp: new Date(),
      attempts: 1,
      body: { ...event, schema_version: 99 } as unknown as UsageEvent,
    },
  ]);
  const ctx = createExecutionContext();
  await adminWorker.queue(batch, bindings);
  const result = await getQueueResult(batch, ctx);
  expect(result.explicitAcks).toContain("valid");
  expect(result.retryMessages).toEqual([{ msgId: "invalid" }]);
  expect(await requestDetail(bindings.CODY_DB, "queued")).toEqual(event);
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
    (await call("/console/api/config", "PUT", { version: -1, config: {} }))
      .status,
  ).toBe(400);
  expect((await call("/console/api/summary?period=invalid")).status).toBe(400);
  expect((await call("/console/api/requests?limit=1000")).status).toBe(400);
  const saved = await call("/console/api/config", "PUT", {
    version: 0,
    config: config(),
  });
  expect(saved.status).toBe(200);
  const content = await saved.text();
  expect(content).not.toContain("test-client-secret");
  expect(
    (await call("/console/api/config", "PUT", { version: 0, config: config() }))
      .status,
  ).toBe(409);
});

test("invalid persisted output is a server error without leaking its values", async () => {
  await publishConfig();
  const privateValue = "private-invalid-policy-value";
  await bindings.CODY_DB.prepare("UPDATE pricing_versions SET policy_json = ?")
    .bind(JSON.stringify({ service_id: privateValue }))
    .run();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await call(
    "/console/api/pricing/history?service_id=provider&model=real-model",
  );
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(body).toContain("invalid data");
  expect(body).not.toContain(privateValue);
  expect(errors).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "admin.response.invalid",
      path: "/console/api/pricing/history",
      issues: expect.any(Array),
    }),
  );
  expect(JSON.stringify(errors.mock.calls)).not.toContain(privateValue);
});

test("pricing preview rejects contradictory counts and runtime uses published client credentials", async () => {
  await publishConfig();
  const invalid = await call("/console/api/pricing/preview", "POST", {
    policy: config().model_policies![0],
    usage: { input_tokens: 10, cache_read_tokens: 20, cache_write_tokens: 0 },
  });
  expect(invalid.status).toBe(400);
  const preview = await call("/console/api/pricing/preview", "POST", {
    policy: config().model_policies![0],
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 400,
      cache_write_tokens: 100,
    },
  });
  expect(preview.status).toBe(200);
  await recordKeyFailure(bindings, "provider", "primary", undefined, "catalog");
  expect(
    await listCoolingHealth(bindings, config().services, "catalog"),
  ).toHaveLength(1);
  const runtime = await call(
    "/console/api/runtime/health/provider/primary?client_id=client&scope=catalog",
    "DELETE",
  );
  expect(runtime.status).toBe(200);
  expect(await runtime.json()).toEqual({ ok: true });
  expect(
    await listCoolingHealth(bindings, config().services, "catalog"),
  ).toEqual([]);
  expect(
    await bindings.CODY_DB.prepare(
      "SELECT action FROM audit_log WHERE action = 'clear_health'",
    ).first(),
  ).toEqual({ action: "clear_health" });
  expect(
    (await call("/console/api/runtime/health?client_id=missing")).status,
  ).toBe(400);
});

test("the unified Worker separates gateway authentication from protected console routes", async () => {
  await publishConfig();
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
  await publishConfig();
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

test("validated RPC drafts accept repeated secret placeholders and never echo invalid credentials", async () => {
  const input = config();
  input.api_keys.push({
    id: "second",
    api_key: "another-client-secret",
    services: ["provider"],
  });
  const saved = await call("/console/api/config", "PUT", {
    version: 0,
    config: input,
  });
  expect(saved.status).toBe(200);
  const draft = (await saved.json()) as {
    version: number;
    config: GatewayConfig;
  };
  expect(draft.config.api_keys.map((client) => client.api_key)).toEqual([
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
  ]);
  const again = await call("/console/api/config", "PUT", {
    version: draft.version,
    config: draft.config,
  });
  expect(again.status).toBe(200);
  input.services[0].base_url = "";
  const invalid = await call("/console/api/config", "PUT", {
    version: 2,
    config: input,
  });
  expect(invalid.status).toBe(400);
  const text = await invalid.text();
  expect(text).not.toContain("test-upstream-secret");
  expect(text).not.toContain("another-client-secret");
});
