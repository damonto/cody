import { antigravityProviderSchema } from "../../src/config/schema.ts";
import { parseConfig } from "../../src/config/store.ts";
import { z } from "zod";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { checkIncrementalConfiguration } from "../helpers/entity-configuration.ts";
import { newAntigravityProvider } from "../helpers/native-provider-fixtures.ts";
import { app } from "../../src/worker.ts";
import { ControlStore, SECRET_PLACEHOLDER } from "../../src/control/store.ts";
import { configurationViewSchema } from "../../src/control/schema.ts";
import { readEntities } from "../../src/control/repository.ts";
import {
  clearConfigCacheForTests,
  loadConfig,
} from "../../src/config/store.ts";
import { config } from "./fixtures.ts";

const identityReplySchema = z.object({
  version: z.number(),
  item: z.object({ id: z.string() }),
});
const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const store = () => new ControlStore(env.CODY_DB, env.CONFIG_ENCRYPTION_KEY);
function call(
  path: string,
  method = "GET",
  value?: unknown,
  headers: Record<string, string> = {},
) {
  if (value && typeof value === "object" && method !== "GET")
    value = { operation_id: crypto.randomUUID(), ...value };
  if (path.endsWith("/reveal") && value && typeof value === "object") {
    const { operation_id: _operation, ...input } = value as {
      operation_id?: string;
    };
    value = input;
  }
  return app.request(
    `http://localhost/console/api${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-cody-admin": "1",
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    },
    env,
    createExecutionContext(),
  );
}
async function save() {
  return store().save(config(), 0, "test");
}
function withoutId<T extends { id: string }>(value: T) {
  const { id: _id, ...input } = value;
  return input;
}
beforeAll(() => applyD1Migrations(env.CODY_DB, bindings.TEST_MIGRATIONS));
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
  await env.CODY_DB.batch(
    tables.map((table) => env.CODY_DB.prepare(`DELETE FROM ${table}`)),
  );
  await env.CODY_DB.prepare(
    "UPDATE config_meta SET version=0,operation_id=NULL,maintenance=0,updated_at=0 WHERE id=1",
  ).run();
});

test("the console starts with an empty current configuration", async () => {
  const response = await call("/config");
  expect(response.status).toBe(200);
  const view = z.object({ version: z.number() }).parse(await response.json());
  expect(view.version).toBe(0);
  expect(await (await call("/providers")).json()).toEqual({
    version: 0,
    etag: expect.any(String),
    item: [],
  });
  expect(view).not.toHaveProperty("published_revision");
});
test("resource mutations require an operation ID", async () => {
  const response = await call("/providers", "POST", {
    version: 0,
    provider: withoutId(config().providers[0]),
    operation_id: undefined,
  });
  expect(response.status).toBe(400);
  expect((await store().state()).version).toBe(0);
});
test("bulk configuration writes, import and export endpoints are removed", async () => {
  for (const [method, path] of [
    ["PUT", "/config"],
    ["PATCH", "/config"],
    ["POST", "/config/imports"],
    ["POST", "/config/export"],
    ["POST", "/config/exports"],
  ])
    expect((await call(path, method, {})).status).toBe(404);
});
test("D1 saves touch only changed rows and swap aliases atomically", async () => {
  await checkIncrementalConfiguration(env.CODY_DB, env.CONFIG_ENCRYPTION_KEY);
});
test("credential reads reject a concurrent version change", async () => {
  const view = await save();
  const readState = ControlStore.prototype.state;
  const read = vi
    .spyOn(ControlStore.prototype, "state")
    .mockImplementationOnce(async function (this: ControlStore) {
      read.mockRestore();
      const next = structuredClone(view.config);
      next.api_keys[0].api_key = "rotated-secret";
      await this.save(next, view.version, "test");
      return readState.call(this);
    });
  try {
    const response = await call(
      `/clients/${view.config.api_keys[0].id}/reveal`,
      "POST",
      { version: view.version },
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("rotated-secret");
  } finally {
    read.mockRestore();
  }
});
test("saving generates UUID identities and applies the snapshot immediately", async () => {
  const view = await save();
  const provider = view.config.providers[0];
  expect(provider.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(provider.name).toBe("Provider");
  expect(view.config.api_keys[0].providers).toEqual([provider.id]);
  const current = await loadConfig(env);
  expect(current.revision).toBe(view.version);
  expect(current.providers[0].id).toBe(provider.id);
  expect(current.api_keys[0].api_key).toBe("test-client-secret");
});
test("database snapshots and responses do not expose plaintext credentials", async () => {
  const view = await save();
  expect(view.config.api_keys[0].api_key).toBe(SECRET_PLACEHOLDER);
  const snapshot = await env.CODY_DB.prepare(
    "SELECT config_json FROM config_snapshots",
  ).first<{ config_json: string }>();
  expect(snapshot!.config_json).not.toContain("test-client-secret");
  const secrets = await env.CODY_DB.prepare(
    "SELECT ciphertext FROM secret_versions",
  ).all();
  expect(JSON.stringify(secrets.results)).not.toContain("test-upstream-secret");
});
test("provider resource updates preserve identities, replay lost responses and reject stale writers", async () => {
  const view = await save();
  const provider = view.config.providers[0];
  const path = `/providers/${provider.id}`;
  const body = {
    version: view.version,
    operation_id: crypto.randomUUID(),
    provider: { ...withoutId(provider), name: "Renamed" },
  };
  const changed = await call(path, "PUT", body);
  expect(changed.status).toBe(200);
  const next = await changed.json();
  expect(next).toMatchObject({
    version: 2,
    item: { id: provider.id, name: "Renamed" },
  });
  expect(next).not.toHaveProperty("config");
  expect(await (await call(path, "PUT", body)).json()).toEqual(next);
  expect(
    (await call(path, "PUT", { ...body, operation_id: crypto.randomUUID() }))
      .status,
  ).toBe(409);
  expect((await store().view()).config.api_keys).toEqual(view.config.api_keys);
});
test("operation IDs are bound to the resource path and payload", async () => {
  const view = await save();
  const body = {
    version: view.version,
    operation_id: crypto.randomUUID(),
    reporting: { time_zone: "UTC", retention_days: 60 },
  };
  expect((await call("/settings/reporting", "PUT", body)).status).toBe(200);
  expect(
    (
      await call("/settings/reporting", "PUT", {
        ...body,
        reporting: { ...body.reporting, retention_days: 90 },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call("/settings/web-search", "PUT", {
        version: view.version,
        operation_id: body.operation_id,
        web_search: { mode: "proxy" },
      })
    ).status,
  ).toBe(409);
});
test("resource creation generates UUIDs and validates references", async () => {
  const created = await call("/providers", "POST", {
    version: 0,
    provider: withoutId(config().providers[0]),
  });
  expect(created.status).toBe(201);
  const { item: provider } = identityReplySchema.parse(await created.json());
  expect(provider.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(created.headers.get("location")).toBe(
    `/console/api/providers/${provider.id}`,
  );
  expect(
    (
      await call("/clients", "POST", {
        version: 1,
        client: {
          ...withoutId(config().api_keys[0]),
          providers: [crypto.randomUUID()],
        },
      })
    ).status,
  ).toBe(400);
  const client = await call("/clients", "POST", {
    version: 1,
    client: { ...withoutId(config().api_keys[0]), providers: [provider.id] },
  });
  expect(client.status).toBe(201);
  expect((await loadConfig(env)).api_keys[0].providers).toEqual([provider.id]);
  expect(
    (
      await call("/clients", "POST", {
        version: 2,
        client: {
          ...withoutId(config().api_keys[0]),
          id: crypto.randomUUID(),
          providers: [provider.id],
        },
      })
    ).status,
  ).toBe(400);
});
test("native singleton settings have their own resource and cannot write credentials", async () => {
  const settings = {
    type: "codex",
    name: "Codex",
    disabled: true,
    priority: 100,
    models: [],
  };
  expect(
    (
      await call("/native-providers/codex", "PUT", {
        version: 0,
        settings: { ...settings, disabled: false },
      })
    ).status,
  ).toBe(400);
  const saved = await call("/native-providers/codex", "PUT", {
    version: 0,
    settings,
  });
  expect(saved.status).toBe(200);
  const { item: provider } = identityReplySchema.parse(await saved.json());
  expect(provider.id).toMatch(/^[0-9a-f-]{36}$/);
  const renamed = await call("/native-providers/codex", "PUT", {
    version: 1,
    settings: { ...settings, name: "Accounts" },
  });
  expect(await renamed.json()).toMatchObject({
    item: { id: provider.id, name: "Accounts" },
  });
  expect(
    (
      await call("/native-providers/codex", "PUT", {
        version: 2,
        settings: { ...settings, credentials: [] },
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(`/providers/${provider.id}`, "DELETE", { version: 2 })).status,
  ).toBe(400);
  expect((await store().current()).providers).toHaveLength(1);
});
test("removing clients preserves their identity for history without an archive API", async () => {
  const view = await save();
  const id = view.config.api_keys[0].id;
  const deleted = await call(`/clients/${id}`, "DELETE", {
    version: view.version,
  });
  expect(deleted.status).toBe(200);
  const next = z.object({ version: z.number() }).parse(await deleted.json());
  expect((await loadConfig(env)).api_keys).toHaveLength(0);
  expect(
    await env.CODY_DB.prepare(
      "SELECT id, name, deleted_at FROM clients WHERE id = ?",
    )
      .bind(id)
      .first(),
  ).toEqual({ id, name: "Client", deleted_at: expect.any(Number) });
  expect(await (await call("/config/names")).json()).toMatchObject({
    names: { [id]: "Client" },
  });
  expect((await call("/config/archived")).status).toBe(404);
  expect(
    (
      await call(`/config/archived/clients/${id}/restore`, "POST", {
        version: next.version,
      })
    ).status,
  ).toBe(404);
  expect((await store().state()).version).toBe(next.version);
});
test("secret reveal checks identity, version, authentication and origin", async () => {
  const view = await save();
  const id = view.config.api_keys[0].id;
  const path = `/clients/${id}/reveal`;
  const response = await call(path, "POST", { version: view.version });
  expect(await response.json()).toEqual({ api_key: "test-client-secret" });
  expect((await call(path, "POST", { version: 0 })).status).toBe(409);
  expect(
    (
      await call(
        path,
        "POST",
        { version: view.version },
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(`/clients/${crypto.randomUUID()}/reveal`, "POST", {
        version: view.version,
      })
    ).status,
  ).toBe(404);
});
test("masked client updates keep secrets and cannot change providers", async () => {
  const view = await save();
  const client = view.config.api_keys[0];
  expect(
    (
      await call(`/clients/${client.id}`, "PUT", {
        version: view.version,
        client: { ...withoutId(client), name: "Renamed client" },
      })
    ).status,
  ).toBe(200);
  expect((await store().current()).api_keys[0].api_key).toBe(
    "test-client-secret",
  );
  expect((await store().view()).config.providers).toEqual(
    view.config.providers,
  );
});
test("price history is created by a save without a publish operation", async () => {
  const view = await save();
  const provider = view.config.providers[0];
  expect(provider.model_settings?.["real-model"].context_window).toBe(
    1_000_000,
  );
  expect(view.config.model_prices![0]).not.toHaveProperty("context_window");
  const response = await call(
    `/pricing/history?provider_id=${provider.id}&model=real-model`,
  );
  expect(await response.json()).toMatchObject({
    items: [{ revision: view.version, price: { model: "real-model" } }],
  });
  expect(
    (await call("/config/publish", "POST", { version: view.version })).status,
  ).toBe(404);
});
test("a restore creates a new version and preserves immutable history", async () => {
  const view = await save();
  view.config.providers[0].name = "Changed";
  const next = await store().save(view.config, view.version, "test");
  const restored = await call("/config/restorations", "POST", {
    version: next.version,
    revision: 1,
  });
  expect(restored.status).toBe(200);
  expect(configurationViewSchema.parse(await restored.json())).toMatchObject({
    version: 3,
    config: { providers: [{ name: "Provider" }] },
  });
  expect((await store().revision(2)).providers[0].name).toBe("Changed");
});
test("a revoked or unavailable SQL configuration fails closed despite a cached snapshot", async () => {
  await save();
  await loadConfig(env);
  await env.CODY_DB.prepare(
    "UPDATE config_meta SET maintenance=1 WHERE id=1",
  ).run();
  await expect(loadConfig(env)).rejects.toThrow("maintenance");
});

test("price and model settings resources update independently and address models by UUID", async () => {
  const view = await save();
  const provider = view.config.providers[0];
  const modelId = provider.model_settings!["real-model"].id!;
  const pricing = view.config.model_prices![0].pricing!;
  const changed = { ...pricing, currency: "EUR" };
  const savedPrice = await call(`/model-prices/${modelId}`, "PUT", {
    version: 1,
    pricing: changed,
  });
  expect(savedPrice.status).toBe(200);
  const itemReply = z.object({ item: z.unknown() });
  const savedItem = itemReply.parse(await savedPrice.json()).item;
  const readItem = itemReply.parse(
    await (await call(`/model-prices/${modelId}`)).json(),
  ).item;
  expect(savedItem).toEqual(readItem);
  expect(savedItem).not.toHaveProperty("version_id");
  expect(
    z.uuid().safeParse((await store().current()).model_prices![0].version_id)
      .success,
  ).toBe(true);
  expect(
    (await store().current()).providers[0].model_settings!["real-model"]
      .context_window,
  ).toBe(1_000_000);
  expect(
    (
      await call(`/providers/${provider.id}/models/${modelId}`, "PUT", {
        version: 2,
        settings: { context_window: 200_000 },
      })
    ).status,
  ).toBe(200);
  expect((await store().current()).model_prices![0].pricing!.currency).toBe(
    "EUR",
  );
  expect(
    (
      await call(`/providers/${crypto.randomUUID()}/models/${modelId}`, "PUT", {
        version: 3,
        settings: { context_window: null },
      })
    ).status,
  ).toBe(404);
  expect(
    (await call(`/model-prices/${modelId}`, "DELETE", { version: 3 })).status,
  ).toBe(200);
  expect((await store().current()).model_prices).toEqual([]);
  expect(
    (await store().current()).providers[0].model_settings!["real-model"]
      .context_window,
  ).toBe(200_000);
});
test("reporting and search resources reject fields from other responsibilities", async () => {
  const view = await save();
  expect(
    (
      await call("/settings/reporting", "PUT", {
        version: 1,
        reporting: { time_zone: "UTC", retention_days: 90 },
        web_search: { mode: "proxy" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/settings/reporting", "PUT", {
        version: 1,
        reporting: { time_zone: "UTC", retention_days: 90 },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/settings/web-search", "PUT", {
        version: 2,
        web_search: { mode: "tavily", api_key: "search-secret" },
      })
    ).status,
  ).toBe(200);
  expect((await store().view()).config.providers).toEqual(
    view.config.providers,
  );
  expect((await store().current()).reporting?.retention_days).toBe(90);
});
test("proxy nodes cannot move across groups, and group removal soft-deletes its children", async () => {
  const groupInput = { name: "Proxies", strategy: "priority", proxies: [] };
  const first = await call("/proxy-groups", "POST", {
    version: 0,
    group: groupInput,
  });
  const { item: group } = identityReplySchema.parse(await first.json());
  const nodeInput = {
    name: "Node",
    url: "socks5://proxy.test:1080",
    priority: 100,
    disabled: false,
  };
  const nodeResponse = await call(`/proxy-groups/${group.id}/nodes`, "POST", {
    version: 1,
    node: nodeInput,
  });
  expect(nodeResponse.status).toBe(201);
  const { item: node } = identityReplySchema.parse(await nodeResponse.json());
  const second = await call("/proxy-groups", "POST", {
    version: 2,
    group: groupInput,
  });
  const { item: other } = identityReplySchema.parse(await second.json());
  expect(
    (
      await call(`/proxy-groups/${other.id}/nodes/${node.id}`, "PUT", {
        version: 3,
        node: nodeInput,
      })
    ).status,
  ).toBe(404);
  expect(
    (await call(`/proxy-groups/${group.id}`, "DELETE", { version: 3 })).status,
  ).toBe(200);
  expect(
    await env.CODY_DB.prepare(
      "SELECT group_id, deleted_at FROM proxy_nodes WHERE id = ?",
    )
      .bind(node.id)
      .first(),
  ).toEqual({ group_id: group.id, deleted_at: expect.any(Number) });
});
test("credential updates and scoped routes preserve the provider's other settings", async () => {
  const view = await save();
  const provider = view.config.providers[0];
  const response = await call(`/providers/${provider.id}/credentials`, "POST", {
    version: 1,
    credential: {
      name: "Second",
      auth: { type: "api_key", api_key: "second-key" },
      priority: 100,
      disabled: false,
    },
  });
  expect(response.status).toBe(201);
  const { item: credential } = identityReplySchema.parse(await response.json());
  const ids = [credential.id, provider.credentials[0].id];
  expect(
    (
      await call(`/providers/${provider.id}/credentials/order`, "PUT", {
        version: 2,
        ids,
      })
    ).status,
  ).toBe(200);
  expect(
    (await store().current()).providers[0].credentials.map((item) => item.id),
  ).toEqual(ids);
  expect(
    (
      await call(`/providers/${provider.id}/model-routes`, "PUT", {
        version: 3,
        routes: { own: { model: "real-model" } },
      })
    ).status,
  ).toBe(200);
  const current = await store().current();
  expect(current.model_routes).toEqual(view.config.model_routes);
  expect(current.providers[0].model_routes?.own.model).toBe("real-model");
  expect(current.providers[0].priority).toBe(provider.priority);
  expect(
    (
      await call(`/providers/${provider.id}/model-routes`, "PUT", {
        version: 4,
        routes: { invalid: { model: "real-model", providers: [provider.id] } },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(`/clients/${view.config.api_keys[0].id}/model-routes`, "PUT", {
        version: 4,
        routes: { client: { model: "real-model", providers: [provider.id] } },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/model-routes", "PUT", {
        version: 5,
        routes: { global: { model: "real-model" } },
      })
    ).status,
  ).toBe(200);
  expect(
    (await store().current()).providers[0].model_routes?.own,
  ).toBeDefined();
});
test("failed resource commits roll back data and leave the previous runtime snapshot active", async () => {
  const view = await save();
  await env.CODY_DB.exec(
    "CREATE TRIGGER reject_resource_save BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  try {
    expect(
      (
        await call("/settings/reporting", "PUT", {
          version: 1,
          reporting: { time_zone: "UTC", retention_days: 90 },
        })
      ).status,
    ).toBe(503);
    expect(await store().view()).toEqual(view);
    expect((await loadConfig(env)).revision).toBe(1);
  } finally {
    await env.CODY_DB.exec("DROP TRIGGER reject_resource_save");
  }
});

test("native settings preserve account references and removing the last account disables its provider", async () => {
  const settings = {
    type: "codex",
    name: "Codex",
    disabled: true,
    priority: 100,
    models: ["model"],
  };
  const created = await call("/native-providers/codex", "PUT", {
    version: 0,
    settings,
  });
  const { item: provider } = identityReplySchema.parse(await created.json());
  const account_ref = crypto.randomUUID();
  await env.CODY_DB.prepare(
    "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, 'codex', 1)",
  )
    .bind(account_ref, provider.id)
    .run();
  const added = await call(`/providers/${provider.id}/credentials`, "POST", {
    version: 1,
    credential: {
      name: "Account",
      priority: 100,
      disabled: false,
      auth: { type: "oauth", account_ref },
    },
  });
  expect(added.status).toBe(201);
  const { item: credential } = identityReplySchema.parse(await added.json());
  expect(
    (
      await call("/native-providers/codex", "PUT", {
        version: 2,
        settings: { ...settings, disabled: false, priority: 200 },
      })
    ).status,
  ).toBe(200);
  const current = await store().current();
  expect(current.providers[0].credentials[0].auth).toEqual({
    type: "oauth",
    account_ref,
  });
  expect(current.providers[0].credentials[0].id).toBe(credential.id);
  expect(
    (
      await call(
        `/providers/${provider.id}/credentials/${credential.id}`,
        "DELETE",
        { version: 3 },
      )
    ).status,
  ).toBe(200);
  expect((await store().current()).providers[0]).toMatchObject({
    disabled: true,
    credentials: [],
    priority: 200,
  });
});

test("provider ordering and deletion automatically detach client references", async () => {
  const view = await save();
  const first = view.config.providers[0];
  const added = await call("/providers", "POST", {
    version: 1,
    provider: {
      ...withoutId(first),
      name: "Second",
      credentials: [
        {
          ...withoutId(first.credentials[0]),
          id: "new-credential",
          auth: { type: "api_key", api_key: "another-key" },
        },
      ],
    },
  });
  expect(added.status).toBe(201);
  const { item: second } = identityReplySchema.parse(await added.json());
  expect(
    (
      await call("/providers/order", "PUT", {
        version: 2,
        ids: [second.id, first.id],
      })
    ).status,
  ).toBe(200);
  expect((await loadConfig(env)).providers.map((item) => item.id)).toEqual([
    second.id,
    first.id,
  ]);
  expect(
    (await call(`/providers/${first.id}`, "DELETE", { version: 3 })).status,
  ).toBe(200);
  const current = await loadConfig(env);
  expect(current.providers.map((provider) => provider.id)).toEqual([second.id]);
  expect(current.api_keys[0]).toMatchObject({
    id: view.config.api_keys[0].id,
    providers: [],
  });
  expect(current.model_routes).toEqual(view.config.model_routes);
  expect(
    await env.CODY_DB.prepare("SELECT deleted_at FROM providers WHERE id = ?")
      .bind(first.id)
      .first(),
  ).toEqual({ deleted_at: expect.any(Number) });
  expect(
    await env.CODY_DB.prepare(
      "SELECT provider_id, deleted_at FROM provider_credentials WHERE id = ?",
    )
      .bind(first.credentials[0].id)
      .first(),
  ).toEqual({ provider_id: first.id, deleted_at: expect.any(Number) });
});

test("provider deletion soft-deletes dependent entities and preserves usable routes and history", async () => {
  const input = config();
  const first = input.providers[0];
  first.models.push("unique-model");
  first.model_routes = { owned: { model: "real-model" } };
  input.providers.push({
    ...first,
    id: "second",
    name: "Second",
    disabled: true,
    models: ["real-model"],
    credentials: [{ ...first.credentials[0], id: "second-key" }],
  });
  const routes = {
    shared: { model: "real-model", providers: ["provider", "second"] },
    unrestricted: { model: "real-model" },
    exclusive: { model: "real-model", providers: ["provider"] },
    orphan: { model: "unique-model" },
    restrictedOrphan: { model: "unique-model", providers: ["provider"] },
    unaffected: { model: "real-model", providers: ["second"] },
  };
  input.model_routes = routes;
  input.api_keys[0].model_routes = routes;
  input.api_keys.push({
    ...input.api_keys[0],
    id: "shared-client",
    name: "Shared client",
    api_key: "shared-client-key",
    providers: ["provider", "second"],
  });
  input.model_prices!.push({
    ...input.model_prices![0],
    provider_id: "second",
  });
  const view = await store().save(input, 0, "test");
  const removed = view.config.providers[0];
  const retained = view.config.providers[1];
  const before = await readEntities(env.CODY_DB);
  const history = await env.CODY_DB.prepare(
    "SELECT * FROM model_price_versions WHERE revision = 1 ORDER BY id",
  ).all();
  const snapshot = await env.CODY_DB.prepare(
    "SELECT * FROM config_snapshots WHERE version = 1",
  ).first();
  const operation = { version: 1, operation_id: crypto.randomUUID() };
  expect(
    (await call(`/providers/${removed.id}`, "DELETE", { version: 0 })).status,
  ).toBe(409);
  expect(await readEntities(env.CODY_DB)).toEqual(before);
  const response = await call(`/providers/${removed.id}`, "DELETE", operation);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ version: 2, item: null });
  const after = await readEntities(env.CODY_DB);
  const deletedAt = after.providers.find(
    (row) => row.id === removed.id,
  )!.deleted_at;
  expect(deletedAt).toEqual(expect.any(Number));
  const modelIds = new Set(
    before.provider_models
      .filter((row) => row.provider_id === removed.id)
      .map((row) => row.id),
  );
  const removedRouteIds = new Set(
    before.model_routes
      .filter(
        (row) =>
          row.provider_id === removed.id ||
          ["exclusive", "orphan", "restrictedOrphan"].includes(row.name),
      )
      .map((row) => row.id),
  );
  for (const row of [
    ...after.provider_credentials.filter(
      (row) => row.provider_id === removed.id,
    ),
    ...after.provider_models.filter((row) => modelIds.has(row.id)),
    ...after.model_prices.filter((row) => modelIds.has(row.provider_model_id)),
    ...after.model_routes.filter((row) => removedRouteIds.has(row.id)),
  ])
    expect(row).toMatchObject({ deleted_at: deletedAt, version: 2 });
  for (const row of after.client_providers)
    expect(row.deleted_at).toBe(
      row.provider_id === removed.id ? deletedAt : null,
    );
  for (const row of after.model_route_providers)
    expect(row.deleted_at).toBe(
      row.provider_id === removed.id || removedRouteIds.has(row.route_id)
        ? deletedAt
        : null,
    );
  expect(after.clients).toEqual(before.clients);
  for (const table of [
    "providers",
    "provider_credentials",
    "provider_models",
    "model_prices",
    "model_routes",
    "client_providers",
    "model_route_providers",
  ] as const)
    expect(after[table]).toHaveLength(before[table].length);
  const current = await store().current();
  expect(current.providers.map((provider) => provider.id)).toEqual([
    retained.id,
  ]);
  expect(current.providers[0].model_routes).toEqual(retained.model_routes);
  expect(current.api_keys.map((client) => client.providers)).toEqual([
    [],
    [retained.id],
  ]);
  const survivingRoutes = (original: typeof view.config.model_routes) => ({
    shared: { ...original.shared, providers: [retained.id] },
    unrestricted: original.unrestricted,
    unaffected: original.unaffected,
  });
  expect(current.model_routes).toEqual(
    survivingRoutes(view.config.model_routes),
  );
  for (const [index, client] of current.api_keys.entries())
    expect(client.model_routes).toEqual(
      survivingRoutes(view.config.api_keys[index].model_routes!),
    );
  expect(current.model_prices).toHaveLength(1);
  expect(current.model_prices![0].provider_id).toBe(retained.id);
  expect(
    (
      await env.CODY_DB.prepare(
        "SELECT * FROM model_price_versions WHERE revision = 1 ORDER BY id",
      ).all()
    ).results,
  ).toEqual(history.results);
  expect(
    await env.CODY_DB.prepare(
      "SELECT * FROM config_snapshots WHERE version = 1",
    ).first(),
  ).toEqual(snapshot);
  const replay = await call(`/providers/${removed.id}`, "DELETE", operation);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ version: 2, item: null });
  expect(await readEntities(env.CODY_DB)).toEqual(after);
});

test("deleting the last provider is atomic and retains a client without upstream access", async () => {
  const view = await save();
  const provider = view.config.providers[0];
  const before = await readEntities(env.CODY_DB);
  await env.CODY_DB.prepare(
    "CREATE TRIGGER reject_provider_detach BEFORE UPDATE ON client_providers BEGIN SELECT RAISE(ABORT, 'detach failed'); END",
  ).run();
  try {
    expect(
      (await call(`/providers/${provider.id}`, "DELETE", { version: 1 }))
        .status,
    ).toBe(503);
    expect(await readEntities(env.CODY_DB)).toEqual(before);
    expect((await loadConfig(env)).providers[0].id).toBe(provider.id);
  } finally {
    await env.CODY_DB.prepare("DROP TRIGGER reject_provider_detach").run();
  }
  expect(
    (await call(`/providers/${provider.id}`, "DELETE", { version: 1 })).status,
  ).toBe(200);
  const current = await loadConfig(env);
  expect(current.providers).toEqual([]);
  expect(current.model_routes).toEqual({});
  expect(current.model_prices).toEqual([]);
  expect(current.api_keys).toEqual([
    {
      ...view.config.api_keys[0],
      api_key: "test-client-secret",
      providers: [],
    },
  ]);
  expect((await call(`/clients/${current.api_keys[0].id}`)).status).toBe(200);
});

test("provider deletion keeps native family routes and ignores archived model support", async () => {
  const input = config();
  const family = "gemini-3.8-flash";
  const native = newAntigravityProvider();
  native.models = [`${family}-low`];
  const provider = input.providers[0];
  provider.models.push(family);
  input.model_routes = {
    family: { model: family },
    orphan: { model: "real-model" },
  };
  const view = await store().save(
    {
      ...input,
      providers: [
        provider,
        native,
        {
          ...provider,
          id: "archived-provider",
          name: "Archived provider",
          models: ["real-model"],
          credentials: [{ ...provider.credentials[0], id: "archived-key" }],
        },
      ],
    },
    0,
    "test",
  );
  const archivedId = view.config.providers[2].id;
  expect(
    (await call(`/providers/${archivedId}`, "DELETE", { version: 1 })).status,
  ).toBe(200);
  const archived = await readEntities(env.CODY_DB);
  expect(
    (
      await call(`/providers/${view.config.providers[0].id}`, "DELETE", {
        version: 2,
      })
    ).status,
  ).toBe(200);
  const current = await loadConfig(env);
  expect(current.model_routes).toEqual({
    family: view.config.model_routes.family,
  });
  expect(current.providers.map((row) => row.id)).toEqual([
    view.config.providers[1].id,
  ]);
  const after = await readEntities(env.CODY_DB);
  expect(after.providers.find((row) => row.id === archivedId)).toEqual(
    archived.providers.find((row) => row.id === archivedId),
  );
  expect(
    after.provider_models.filter((row) => row.provider_id === archivedId),
  ).toEqual(
    archived.provider_models.filter((row) => row.provider_id === archivedId),
  );
});

test("resource reads mask secrets without decrypting them, and ordinary CRUD bypasses document replacement", async () => {
  const view = await save();
  const current = vi
    .spyOn(ControlStore.prototype, "current")
    .mockRejectedValue(new Error("Full configuration read is forbidden"));
  const replace = vi
    .spyOn(ControlStore.prototype, "save")
    .mockRejectedValue(new Error("Document replacement is forbidden"));
  try {
    await env.CODY_DB.prepare(
      "UPDATE secret_versions SET ciphertext = 'unreadable' WHERE owner_id = ?",
    )
      .bind(view.config.providers[0].credentials[0].id)
      .run();
    expect((await call("/providers")).status).toBe(200);
    expect((await call("/clients")).status).toBe(200);
    const client = await call(
      `/clients/${view.config.api_keys[0].id}/reveal`,
      "POST",
      { version: 1 },
    );
    expect(await client.json()).toEqual({ api_key: "test-client-secret" });
    expect(
      (
        await call("/settings/reporting", "PUT", {
          version: 1,
          reporting: { time_zone: "UTC", retention_days: 90 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/providers/${view.config.providers[0].id}`, "PUT", {
          version: 2,
          provider: {
            ...withoutId(view.config.providers[0]),
            name: "Renamed without opening the key",
          },
        })
      ).status,
    ).toBe(200);
    expect(current).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  } finally {
    current.mockRestore();
    replace.mockRestore();
  }
});

test("entity repositories validate loaded rows without loading unrelated resources", async () => {
  await save();
  await env.CODY_DB.prepare("UPDATE providers SET priority = 'invalid'").run();
  expect((await call("/providers")).status).toBe(500);
  expect((await call("/settings/reporting")).status).toBe(200);
  const metadata = await (await call("/config")).json();
  expect(metadata).toMatchObject({ version: 1 });
  expect(metadata).not.toHaveProperty("config");
});

test("entity edits reject duplicate plaintext client keys and roll back their secret versions", async () => {
  const view = await save();
  const count = await env.CODY_DB.prepare(
    "SELECT COUNT(*) AS total FROM secret_versions",
  ).first();
  const response = await call("/clients", "POST", {
    version: 1,
    client: {
      name: "Duplicate",
      api_key: "test-client-secret",
      providers: [view.config.providers[0].id],
    },
  });
  expect(response.status).toBe(400);
  expect((await store().state()).version).toBe(1);
  expect(
    await env.CODY_DB.prepare(
      "SELECT COUNT(*) AS total FROM secret_versions",
    ).first(),
  ).toEqual(count);
});

test("resource reads expose only selected tables and ignore archived rows", async () => {
  await save();
  await store().resource(["settings"], (rows) => {
    // @ts-expect-error A projection cannot accidentally depend on an unrequested table.
    expect(rows.providers).toBeUndefined();
    expect(rows.settings).toHaveLength(2);
    return null;
  });
  await env.CODY_DB.prepare(
    "UPDATE providers SET deleted_at = 1, priority = 'invalid'",
  ).run();
  const response = await call("/providers");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ item: [] });
});

test("resource tags detect hidden key rotation without changing unrelated settings", async () => {
  await save();
  const read = async (path: string) =>
    z
      .object({ version: z.number(), etag: z.string(), item: z.unknown() })
      .parse(await (await call(path)).json());
  await call("/settings/web-search", "PUT", {
    version: 1,
    web_search: { mode: "tavily", api_key: "first-search-key" },
  });
  const search = await read("/settings/web-search");
  const reporting = await read("/settings/reporting");
  await call("/settings/web-search", "PUT", {
    version: 2,
    web_search: { mode: "tavily", api_key: "rotated-search-key" },
  });
  const next = await read("/settings/web-search");
  expect(next.item).toEqual(search.item);
  expect(next.etag).not.toBe(search.etag);
  expect((await read("/settings/reporting")).etag).toBe(reporting.etag);
  expect(JSON.stringify(next)).not.toContain("rotated-search-key");
});

test("family prices and context update every thinking level in one fenced transaction", async () => {
  const family = "gemini-3.8-flash";
  const models = ["low", "medium", "high"].map((level) => `${family}-${level}`);
  const input = parseConfig(config());
  input.providers.push(
    antigravityProviderSchema.parse({
      type: "antigravity",
      id: "antigravity",
      name: "Antigravity",
      priority: 100,
      disabled: true,
      models,
      credentials: [],
      account_selection: "round_robin",
    }),
  );
  const initial = await store().save(input, 0, "test");
  const provider = initial.config.providers.find(
    (entry) => entry.type === "antigravity",
  )!;
  const modelId = provider.model_settings![models[0]].id!;
  const pricing = {
    ...initial.config.model_prices![0].pricing!,
    currency: "EUR",
  };
  const reply = await call(`/model-prices/${modelId}/family`, "PUT", {
    version: initial.version,
    pricing,
  });
  expect(reply.status).toBe(200);
  const priced = await store().current();
  const rates = priced.model_prices!.filter(
    (price) => price.provider_id === provider.id,
  );
  expect(rates).toHaveLength(3);
  expect(rates.every((price) => price.pricing?.currency === "EUR")).toBe(true);
  expect(new Set(rates.map((price) => price.id)).size).toBe(3);
  expect(
    (
      await call(`/providers/${provider.id}/models/${modelId}/family`, "PUT", {
        version: initial.version + 1,
        settings: { context_window: 1000000 },
      })
    ).status,
  ).toBe(200);
  const current = await store().current();
  expect(
    models.map(
      (model) =>
        current.providers.find((entry) => entry.id === provider.id)!
          .model_settings![model].context_window,
    ),
  ).toEqual([1000000, 1000000, 1000000]);
  expect(
    (
      await call(`/model-prices/${modelId}/family`, "PUT", {
        version: initial.version + 1,
        pricing: { ...pricing, currency: "JPY" },
      })
    ).status,
  ).toBe(409);
  expect(
    (await store().current())
      .model_prices!.filter((price) => price.provider_id === provider.id)
      .every((price) => price.pricing?.currency === "EUR"),
  ).toBe(true);
  const history = await call(
    `/pricing/history?provider_id=${provider.id}&model=${family}`,
  );
  expect(history.status).toBe(200);
  const entries = z
    .object({
      items: z.array(
        z.object({
          revision: z.number(),
          price: z.object({ model: z.string() }),
        }),
      ),
    })
    .parse(await history.json()).items;
  expect(entries.length).toBeGreaterThan(0);
  expect(new Set(entries.map((item) => item.revision)).size).toBe(
    entries.length,
  );
  expect(entries.every((entry) => entry.price.model === family)).toBe(true);
  expect(
    (
      await call(`/model-prices/${modelId}/family`, "DELETE", {
        version: initial.version + 2,
      })
    ).status,
  ).toBe(200);
  expect(
    (await store().current()).model_prices!.filter(
      (price) => price.provider_id === provider.id,
    ),
  ).toEqual([]);
  const ordinary = initial.config.providers.find(
    (entry) => entry.type === "ai_gateway",
  )!;
  expect(
    (
      await call(
        `/model-prices/${ordinary.model_settings!["real-model"].id}/family`,
        "PUT",
        { version: initial.version + 3, pricing },
      )
    ).status,
  ).toBe(400);
});

test("enabling a new thinking level inherits the shared family price and context", async () => {
  const family = "gemini-3.8-flash";
  const high = `${family}-high`;
  const low = `${family}-low`;
  const input = parseConfig(config());
  input.providers.push(
    antigravityProviderSchema.parse({
      type: "antigravity",
      id: "antigravity",
      name: "Antigravity",
      disabled: true,
      priority: 100,
      models: [high],
      credentials: [],
      model_settings: {
        [high]: { id: crypto.randomUUID(), context_window: 1000000 },
      },
    }),
  );
  input.model_prices!.push({
    id: crypto.randomUUID(),
    provider_id: "antigravity",
    model: high,
    pricing: input.model_prices![0].pricing,
  });
  const initial = await store().save(input, 0, "test");
  const provider = initial.config.providers.find(
    (entry) => entry.type === "antigravity",
  )!;
  const { id: _id, credentials: _credentials, ...settings } = provider;
  const response = await call("/native-providers/antigravity", "PUT", {
    version: initial.version,
    settings: { ...settings, models: [high, low] },
  });
  expect(response.status).toBe(200);
  const saved = await store().current();
  expect(
    saved.providers.find((entry) => entry.id === provider.id)?.model_settings?.[
      low
    ].context_window,
  ).toBe(1000000);
  const prices = saved.model_prices!.filter(
    (price) => price.provider_id === provider.id,
  );
  expect(prices).toHaveLength(2);
  expect(prices[0].pricing).toEqual(prices[1].pricing);
  expect(prices[0].id).not.toBe(prices[1].id);
  const lowPriceId = prices.find((price) => price.model === low)!.id;
  const {
    id: _savedId,
    credentials: _savedCredentials,
    ...savedSettings
  } = saved.providers.find((entry) => entry.id === provider.id)!;
  expect(
    (
      await call("/native-providers/antigravity", "PUT", {
        version: initial.version + 1,
        settings: { ...savedSettings, models: [high] },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/native-providers/antigravity", "PUT", {
        version: initial.version + 2,
        settings: { ...savedSettings, models: [high, low] },
      })
    ).status,
  ).toBe(200);
  const reenabled = (await store().current()).model_prices!.find(
    (price) => price.provider_id === provider.id && price.model === low,
  )!;
  expect(reenabled.pricing).toEqual(prices[0].pricing);
  expect(reenabled.id).toBe(lowPriceId);
});
