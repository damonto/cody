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
import {
  clearConfigCacheForTests,
  parseConfig,
} from "../../src/config/store.ts";
import {
  listCoolingHealth,
  recordCredentialFailure,
} from "../../src/gateway/health/health.ts";
import { authenticateAdmin, safeAdminMutation } from "../../src/admin/auth.ts";
import { ControlStore, SECRET_PLACEHOLDER } from "../../src/control/store.ts";
import { decryptConfig, encryptConfig } from "../../src/control/crypto.ts";
import { draftViewSchema } from "../../src/control/schema.ts";
import type { ConfigPublisher } from "../../src/platform/cloudflare/objects.ts";
import type { PublisherReply } from "../../src/control/publisher.ts";
import {
  cleanupRequests,
  ingestUsage,
  requestDetail,
  requestList,
  summary,
} from "../../src/reporting/store.ts";
import type { UsageEvent } from "../../src/telemetry/types.ts";
import { RequestMeter } from "../../src/telemetry/meter.ts";
import type { GatewayConfig } from "../../src/config/types.ts";
import { emptyUsage } from "../../src/telemetry/usage.ts";
import { emptyCost } from "../../src/billing/calculate.ts";
import { config, usage } from "./fixtures.ts";
import { proxyGroupSnapshot } from "../../src/gateway/proxies/configuration.ts";
import { proxyGroupsStatusSchema } from "../../src/gateway/proxies/schema.ts";

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
  next.providers[0].priority = 200;
  await control().save(next, 1, "tester");
  expect(
    ((await control().rawDraft()) as ReturnType<typeof config>).providers[0]
      .credentials[0].auth.api_key,
  ).toBe("test-upstream-secret");
  await expect(control().save(next, 1, "stale-editor")).rejects.toThrow(
    "draft changed",
  );
  next.providers[0].credentials[0].id = "renamed";
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

test("group proxy passwords stay encrypted and survive masked draft edits", async () => {
  const input = parseConfig(config());
  input.proxy_groups = [
    {
      id: "US",
      strategy: "sticky",
      proxies: [
        {
          id: "first",
          url: "socks5://first.test:1080",
          username: "user",
          password: "first-proxy-secret",
          priority: 100,
          disabled: false,
        },
        {
          id: "second",
          url: "socks5://second.test:1080",
          username: "user",
          password: "second-proxy-secret",
          priority: 50,
          disabled: false,
        },
      ],
    },
  ];
  input.providers[0].proxy_group = "US";
  const saved = await control().save(input, 0, "tester");
  expect(saved.config.proxy_groups[0].proxies[0].password).toBe(
    SECRET_PLACEHOLDER,
  );
  expect(JSON.stringify(saved)).not.toContain("proxy-secret");
  expect((await control().state()).draft_payload).not.toContain("proxy-secret");
  saved.config.proxy_groups[0].proxies.reverse();
  await control().save(saved.config, 1, "tester");
  const restored = parseConfig(await control().rawDraft());
  expect(restored.proxy_groups[0].proxies[0].password).toBe(
    "second-proxy-secret",
  );
  expect(restored.proxy_groups[0].proxies[1].password).toBe(
    "first-proxy-secret",
  );
});

test("proxy runtime endpoints expose published health and bindings, mask secrets and audit clears", async () => {
  const input = config();
  const group = {
    id: `admin-${crypto.randomUUID()}`,
    strategy: "sticky" as const,
    proxies: [
      {
        id: "node",
        url: "socks5://proxy.test:1080",
        username: "user",
        password: "proxy-secret",
        priority: 100,
        disabled: false,
      },
    ],
  };
  input.proxy_groups = [group];
  input.providers[0].proxy_group = group.id;
  const saved = await control().save(input, 0, "tester");
  const revision = await control().createRevision(saved.version, "tester");
  await control().publishRevision(revision);
  const snapshot = await proxyGroupSnapshot({ revision }, group);
  const stub = bindings.PROXY_GROUP.getByName(group.id);
  const selected = await stub.select({
    group: snapshot,
    owner: { provider_id: "provider" },
  });
  if (selected.status !== "selected")
    throw new Error("Expected a proxy binding");
  let response = await call("/console/api/runtime/proxy-groups");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("proxy-secret");
  expect(
    proxyGroupsStatusSchema.parse(JSON.parse(text)).items[0].bindings,
  ).toHaveLength(1);
  for (let index = 0; index < 3; index++)
    await stub.observe({
      lease: selected.lease,
      outcome: "failure",
      event_id: crypto.randomUUID(),
      observed_at: Date.now(),
    });
  response = await call("/console/api/runtime/proxy-groups");
  expect(
    proxyGroupsStatusSchema.parse(await response.json()).items[0].proxies[0]
      .status,
  ).toBe("cooling");
  expect(
    (
      await call(
        `/console/api/runtime/proxy-groups/${group.id}/proxies/node/health`,
        "DELETE",
      )
    ).status,
  ).toBe(200);
  expect((await stub.getStatus(snapshot)).proxies[0].failures).toBe(0);
  expect(
    await bindings.CODY_DB.prepare(
      "SELECT action FROM audit_log WHERE action = ?",
    )
      .bind(`clear_proxy_health:${group.id}:node`)
      .first(),
  ).toEqual({ action: `clear_proxy_health:${group.id}:node` });
  expect(
    (
      await call(
        `/console/api/runtime/proxy-groups/${group.id}/proxies/missing/health`,
        "DELETE",
      )
    ).status,
  ).toBe(404);
});

test("unresolved proxy group references can be saved but cannot be published", async () => {
  const input = config();
  input.providers[0].proxy_group = "missing";
  const saved = await control().save(input, 0, "tester");
  expect(saved.valid).toBe(false);
  const reply = JSON.parse(
    await publisher().publish(saved.version, "tester"),
  ) as PublisherReply;
  expect(reply.ok).toBe(false);
  expect(await bindings.CODY_CONFIG_KV.get("gateway-config")).toBeNull();
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
    )?.providers,
  ).toEqual(config().providers);
});

test("structurally invalid drafts are rejected; incomplete references cannot be published", async () => {
  await expect(
    control().save({ providers: "invalid", api_keys: [] }, 0, "tester"),
  ).rejects.toThrow();
  const input = config();
  input.api_keys[0].providers = ["missing"];
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
    "responses/compact",
    "chat/completions",
    "images/generations",
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
  const batch = createMessageBatch<UsageEvent>("cody-usage", [
    ...ignored.map((body) => ({
      id: body.request_id,
      timestamp: new Date(),
      attempts: 1,
      // Queue payloads can predate the current event type.
      body: body as unknown as UsageEvent,
    })),
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

test("client credentials can be read individually from the current draft without changing credentials", async () => {
  const published = await publishConfig();
  const input = config();
  const rotated = `sk-cody-${"a1".repeat(32)}`;
  input.api_keys[0].api_key = rotated;
  input.api_keys.unshift({
    id: "other-client",
    api_key: "custom-client-key",
    providers: ["provider"],
  });
  const saved = await control().save(input, published.version, "tester");
  const before = await control().state();
  const audit = await bindings.CODY_DB.prepare("SELECT * FROM audit_log").all();
  for (const [id, api_key] of [
    ["client", rotated],
    ["other-client", "custom-client-key"],
  ]) {
    const response = await call(
      `/console/api/config/clients/${id}/reveal`,
      "POST",
      {
        version: saved.version,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ api_key });
  }
  expect(await control().state()).toEqual(before);
  expect(
    (await bindings.CODY_DB.prepare("SELECT * FROM audit_log").all()).results,
  ).toEqual(audit.results);
  expect(await bindings.CODY_CONFIG_KV.get("gateway-config")).toContain(
    "test-client-secret",
  );

  const draft = await call("/console/api/config");
  const view = draftViewSchema.parse(await draft.json());
  expect(view.config.api_keys.map((client) => client.api_key)).toEqual([
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
  ]);
  const unchanged = await call("/console/api/config", "PUT", {
    version: view.version,
    config: view.config,
  });
  expect(unchanged.status).toBe(200);
  expect(await unchanged.text()).not.toContain(rotated);
  expect(parseConfig(await control().rawDraft()).api_keys).toEqual(
    input.api_keys,
  );
});

test("client key reads reject missing clients, invalid input, and stale versions", async () => {
  const saved = await control().save(config(), 0, "tester");
  const path = "/console/api/config/clients/client/reveal";
  for (const version of [0, saved.version + 1]) {
    const stale = await call(path, "POST", { version });
    expect(stale.status).toBe(409);
    expect(await stale.text()).not.toContain("test-client-secret");
  }
  const missing = await call(
    "/console/api/config/clients/missing/reveal",
    "POST",
    {
      version: saved.version,
    },
  );
  expect(missing.status).toBe(404);
  for (const input of [{}, { version: -1 }, { version: 0.5 }, { version: "1" }])
    expect((await call(path, "POST", input)).status).toBe(400);
  expect(
    (
      await call("/console/api/config/clients/invalid%20id/reveal", "POST", {
        version: saved.version,
      })
    ).status,
  ).toBe(400);
  expect((await call(path)).status).toBe(404);

  await control().save({ ...config(), api_keys: [] }, saved.version, "tester");
  expect(
    (await call(path, "POST", { version: saved.version + 1 })).status,
  ).toBe(404);
});

test("client key reads require administrator authentication and same-origin JSON requests", async () => {
  await control().save(config(), 0, "tester");
  const path = "/console/api/config/clients/client/reveal";
  const unauthenticated = await app.request(
    `https://gateway.example${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cody-admin": "1",
        authorization: "Bearer test-client-secret",
      },
      body: JSON.stringify({ version: 1 }),
    },
    bindings,
  );
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { "x-cody-admin": "" },
  ]) {
    const response = await call(path, "POST", { version: 1 }, headers);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("test-client-secret");
  }
  expect(
    (
      await call(
        path,
        "POST",
        { version: 1 },
        {
          "content-type": "text/plain",
        },
      )
    ).status,
  ).toBe(415);
});

test("client key reads work in an unpublished draft with unresolved provider references", async () => {
  const input = config();
  input.api_keys[0].providers = ["missing"];
  const saved = await control().save(input, 0, "tester");
  expect(saved.valid).toBe(false);
  expect(saved.published_revision).toBeNull();
  const response = await call(
    "/console/api/config/clients/client/reveal",
    "POST",
    {
      version: saved.version,
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ api_key: "test-client-secret" });
});

test("client key reads fail closed on invalid or unreadable stored credentials", async () => {
  await control().save(config(), 0, "tester");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const input = config();
  input.api_keys[0].api_key = SECRET_PLACEHOLDER;
  await bindings.CODY_DB.prepare(
    "UPDATE control_state SET draft_payload = ? WHERE id = 1",
  )
    .bind(await encryptConfig(input, bindings.CONFIG_ENCRYPTION_KEY))
    .run();
  const invalid = await call(
    "/console/api/config/clients/client/reveal",
    "POST",
    { version: 1 },
  );
  expect(invalid.status).toBe(500);
  expect(await invalid.text()).not.toContain(SECRET_PLACEHOLDER);
  expect(JSON.stringify(errors.mock.calls)).not.toContain(
    "test-upstream-secret",
  );
  expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET_PLACEHOLDER);

  await bindings.CODY_DB.prepare(
    "UPDATE control_state SET draft_payload = 'unreadable' WHERE id = 1",
  ).run();
  const unreadable = await call(
    "/console/api/config/clients/client/reveal",
    "POST",
    { version: 1 },
  );
  expect(unreadable.status).toBe(503);
  expect(await unreadable.text()).not.toContain("test-client-secret");
});

for (const mode of ["tavily", "exa"] as const) {
  test(`provider and ${mode} credentials can be viewed without changing the draft`, async () => {
    const input = config();
    input.providers.push({
      ...input.providers[0],
      id: "other-provider",
      credentials: [
        {
          id: "primary",
          auth: { type: "api_key", api_key: "other-upstream-key" },
          priority: 100,
          disabled: false,
        },
      ],
    });
    input.web_search = {
      mode,
      prefer_native: false,
      api_key: "test-search-key",
      base_url: "https://search.example",
      max_results: 5,
    };
    const saved = await control().save(input, 0, "tester");
    const before = await control().state();
    for (const [path, api_key] of [
      [
        "/providers/provider/credentials/primary/reveal",
        "test-upstream-secret",
      ],
      [
        "/providers/other-provider/credentials/primary/reveal",
        "other-upstream-key",
      ],
      ["/web-search/reveal", "test-search-key"],
    ]) {
      const response = await call(`/console/api/config${path}`, "POST", {
        version: saved.version,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ api_key });
    }
    expect(await control().state()).toEqual(before);
    const draft = draftViewSchema.parse(
      await (await call("/console/api/config")).json(),
    );
    expect(
      draft.config.providers.map((provider) =>
        provider.credentials[0].auth.type === "api_key"
          ? provider.credentials[0].auth.api_key
          : undefined,
      ),
    ).toEqual([SECRET_PLACEHOLDER, SECRET_PLACEHOLDER]);
    expect(draft.config.web_search).toMatchObject({
      api_key: SECRET_PLACEHOLDER,
    });
    const unchanged = await call("/console/api/config", "PUT", {
      version: draft.version,
      config: draft.config,
    });
    expect(unchanged.status).toBe(200);
    const raw = parseConfig(await control().rawDraft());
    expect(raw.providers).toEqual(input.providers);
    expect(raw.web_search).toEqual(input.web_search);
  });
}

for (const path of [
  "/console/api/config/providers/provider/credentials/primary/reveal",
  "/console/api/config/web-search/reveal",
  "/console/api/config/export",
]) {
  test(`credential access validates authentication, origin, and draft version: ${path}`, async () => {
    const input = config();
    input.web_search = {
      mode: "tavily",
      prefer_native: false,
      api_key: "test-search-key",
      base_url: "https://search.example",
      max_results: 5,
    };
    await control().save(input, 0, "tester");
    const unauthenticated = await app.request(
      `https://gateway.example${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cody-admin": "1",
          authorization: "Bearer test-client-secret",
        },
        body: JSON.stringify({ version: 1 }),
      },
      bindings,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
    for (const headers of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "x-cody-admin": "" },
    ]) {
      const response = await call(path, "POST", { version: 1 }, headers);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const version of [0, 2]) {
      const stale = await call(path, "POST", { version });
      expect(stale.status).toBe(409);
      expect(await stale.text()).not.toContain("test-search-key");
    }
    for (const body of [{}, { version: -1 }, { version: "1" }]) {
      expect((await call(path, "POST", body)).status).toBe(400);
    }
    expect(
      (
        await call(
          path,
          "POST",
          { version: 1 },
          { "content-type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    expect((await call(path)).status).toBe(404);
    expect(
      (
        await bindings.CODY_DB.prepare(
          "SELECT * FROM audit_log WHERE action = 'export_secrets'",
        ).all()
      ).results,
    ).toEqual([]);
  });
}

test("provider and search key reads reject missing or invalid credential targets", async () => {
  await control().save(config(), 0, "tester");
  for (const path of [
    "/providers/missing/credentials/primary/reveal",
    "/providers/provider/credentials/missing/reveal",
    "/web-search/reveal",
  ]) {
    expect(
      (await call(`/console/api/config${path}`, "POST", { version: 1 })).status,
    ).toBe(404);
  }
  expect(
    (
      await call(
        "/console/api/config/providers/provider/credentials/invalid%20id/reveal",
        "POST",
        { version: 1 },
      )
    ).status,
  ).toBe(400);
});

for (const target of ["provider", "search"]) {
  test(`${target} key reads reject a stored placeholder and unreadable ciphertext`, async () => {
    const input = config();
    input.web_search = {
      mode: "tavily",
      prefer_native: false,
      api_key: "test-search-key",
      base_url: "https://search.example",
      max_results: 5,
    };
    await control().save(input, 0, "tester");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const path =
      target === "provider"
        ? "/console/api/config/providers/provider/credentials/primary/reveal"
        : "/console/api/config/web-search/reveal";
    if (target === "provider")
      input.providers[0].credentials[0].auth.api_key = SECRET_PLACEHOLDER;
    else input.web_search.api_key = SECRET_PLACEHOLDER;
    await bindings.CODY_DB.prepare(
      "UPDATE control_state SET draft_payload = ? WHERE id = 1",
    )
      .bind(await encryptConfig(input, bindings.CONFIG_ENCRYPTION_KEY))
      .run();
    const response = await call(path, "POST", { version: 1 });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(SECRET_PLACEHOLDER);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("test-search-key");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(
      "test-upstream-secret",
    );
    await bindings.CODY_DB.prepare(
      "UPDATE control_state SET draft_payload = 'unreadable' WHERE id = 1",
    ).run();
    expect((await call(path, "POST", { version: 1 })).status).toBe(503);
  });
}

test("invalid persisted output is a server error without leaking its values", async () => {
  await publishConfig();
  const privateValue = "private-invalid-policy-value";
  await bindings.CODY_DB.prepare("UPDATE pricing_versions SET policy_json = ?")
    .bind(JSON.stringify({ provider_id: privateValue }))
    .run();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await call(
    "/console/api/pricing/history?provider_id=provider&model=real-model",
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
  await recordCredentialFailure(
    bindings,
    "provider",
    "primary",
    undefined,
    "catalog",
  );
  expect(
    await listCoolingHealth(bindings, config().providers, "catalog"),
  ).toHaveLength(1);
  const runtime = await call(
    "/console/api/runtime/health/provider/primary?client_id=client&scope=catalog",
    "DELETE",
  );
  expect(runtime.status).toBe(200);
  expect(await runtime.json()).toEqual({ ok: true });
  expect(
    await listCoolingHealth(bindings, config().providers, "catalog"),
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
    providers: ["provider"],
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
  if (input.providers[0].type !== "ai_gateway")
    throw new Error("Expected an AI Gateway fixture");
  input.providers[0].base_url = "";
  const invalid = await call("/console/api/config", "PUT", {
    version: 2,
    config: input,
  });
  expect(invalid.status).toBe(400);
  const text = await invalid.text();
  expect(text).not.toContain("test-upstream-secret");
  expect(text).not.toContain("another-client-secret");
});

test("secret-bearing exports return the plaintext draft, audit the actor, and round-trip on import", async () => {
  const input = config();
  input.web_search = {
    mode: "tavily",
    prefer_native: false,
    api_key: "test-search-key",
    base_url: "https://search.example",
    max_results: 5,
  };
  const saved = await control().save(input, 0, "tester");
  const before = await control().state();
  const response = await call("/console/api/config/export", "POST", {
    version: saved.version,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const exported: unknown = await response.json();
  expect(exported).toEqual(parseConfig(await control().rawDraft()));
  expect(JSON.stringify(exported)).not.toContain(SECRET_PLACEHOLDER);
  expect(await control().state()).toEqual(before);
  const audit = await bindings.CODY_DB.prepare(
    "SELECT actor, action FROM audit_log WHERE action = 'export_secrets'",
  ).all();
  expect(audit.results).toEqual([
    { actor: "local-admin", action: "export_secrets" },
  ]);

  await bindings.CODY_DB.prepare(
    "UPDATE control_state SET draft_version = 0, draft_payload = NULL WHERE id = 1",
  ).run();
  const imported = await call("/console/api/config", "PUT", {
    version: 0,
    config: exported,
  });
  expect(imported.status).toBe(200);
  expect(await imported.text()).not.toContain("test-search-key");
  expect(parseConfig(await control().rawDraft())).toEqual(exported);
});

test("secret-bearing exports fail closed on a stored placeholder", async () => {
  const input = config();
  input.api_keys[0].api_key = SECRET_PLACEHOLDER;
  await bindings.CODY_DB.prepare(
    "UPDATE control_state SET draft_version = 1, draft_payload = ? WHERE id = 1",
  )
    .bind(await encryptConfig(input, bindings.CONFIG_ENCRYPTION_KEY))
    .run();
  const response = await call("/console/api/config/export", "POST", {
    version: 1,
  });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("test-upstream-secret");
});
