import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, test } from "vitest";
import { sessionModelBindings } from "../helpers/session-model-bindings.ts";
import {
  sessionAffinityIdentity,
  SESSION_AFFINITY_TTL_MS,
  type SessionAffinityRecord,
} from "../../src/gateway/routing/affinity.ts";
import {
  resolveModelRoute,
  selectAvailableProviderWithDetails,
} from "../../src/gateway/routing/routing.ts";
import { parseConfig } from "../../src/config/store.ts";
import { handleSessions } from "../../src/gateway/sessions/handlers.ts";
import { RequestLogContext } from "../../src/shared/log.ts";

const candidates = ["one", "two"].map((provider_id) => ({
  provider_id,
  priority: 1,
  credentials: [{ credential_id: provider_id, priority: 1 }],
}));

test("model bindings survive eviction and fence deletion independently", async () => {
  await sessionModelBindings(env, async (objectName) => {
    await evictDurableObject(env.SESSION_AFFINITY.getByName(objectName));
    return env;
  });
});

test("structured model identity cannot confuse delimiters with tuple boundaries", async () => {
  const left = await sessionAffinityIdentity("client", "a:b", "c");
  const right = await sessionAffinityIdentity("client", "a", "b:c");
  expect(left.session_digest).not.toBe(right.session_digest);
});

test("concurrent first allocations rotate once per model and keep both accounts", async () => {
  const id = crypto.randomUUID();
  const a = await sessionAffinityIdentity(id, id, "a");
  const b = await sessionAffinityIdentity(id, id, "b");
  const stub = env.SESSION_AFFINITY.getByName(a.object_name);
  const pool = [
    {
      provider_id: id,
      priority: 1,
      credentials: [
        { credential_id: "a", priority: 1 },
        { credential_id: "b", priority: 1 },
      ],
    },
  ];
  const values = await Promise.all(
    [a, a, b, b].map((registration) =>
      stub.resolve(pool, undefined, registration, {
        roundRobinProviderIds: [id],
      }),
    ),
  );
  expect(values[0]?.credential_id).toBe(values[1]?.credential_id);
  expect(values[2]?.credential_id).toBe(values[3]?.credential_id);
  expect(values[0]?.credential_id).not.toBe(values[2]?.credential_id);
});

test("each model expires independently and the alarm retains the next expiry", async () => {
  const id = crypto.randomUUID();
  const a = await sessionAffinityIdentity(id, id, "a");
  const b = await sessionAffinityIdentity(id, id, "b");
  const stub = env.SESSION_AFFINITY.getByName(a.object_name);
  await stub.resolve(candidates, undefined, a);
  await stub.resolve(candidates, undefined, b);
  await expect
    .poll(
      async () => (await stub.getStatus(b.session_digest))?.index_registered,
    )
    .toBe(true);
  const bExpires = Date.now() + 120_000;
  await runInDurableObject(stub, async (_instance, state) => {
    for (const [identity, expires] of [
      [a, Date.now() - 1000],
      [b, bExpires],
    ] as const) {
      const key = `affinity:${identity.session_digest}`;
      const record = await state.storage.get<SessionAffinityRecord>(key);
      expect(record).toBeDefined();
      await state.storage.put(key, {
        ...record,
        updated_at: expires - SESSION_AFFINITY_TTL_MS,
      });
    }
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await stub.getStatus(a.session_digest)).toBeNull();
  expect(await stub.getStatus(b.session_digest)).not.toBeNull();
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBe(bExpires);
  });
  const index = env.SESSION_AFFINITY_INDEX.getByName(a.registry_name);
  await expect.poll(() => index.get(a.session_digest)).toBeNull();
  expect(await index.get(b.session_digest)).not.toBeNull();
});

test("routing and session APIs isolate requested models, aliases and clients", async () => {
  const id = crypto.randomUUID();
  const config = parseConfig({
    providers: ["a", "b"].map((model) => ({
      id: `${model}-${id}`,
      type: "ai_gateway",
      base_url: `https://${model}.example/v1`,
      priority: 1,
      disabled: false,
      models: [model],
      credentials: [
        {
          id: `key-${model}`,
          auth: { type: "api_key", api_key: "secret" },
          priority: 1,
          disabled: false,
        },
      ],
    })),
    api_keys: [{ id, api_key: "client", providers: [`a-${id}`, `b-${id}`] }],
    model_routes: { alias: { model: "a" } },
  });
  const client = config.api_keys[0];
  const sessionId = "session/with?characters";
  const select = (model: string, clientId = id) =>
    selectAvailableProviderWithDetails(
      env,
      resolveModelRoute(config, client, model),
      { session: { clientId, sessionId } },
    );
  expect((await select("a")).affinity?.status).toBe("created");
  expect((await select("b")).target?.provider.id).toBe(`b-${id}`);
  expect((await select("a")).affinity?.status).toBe("hit");
  expect((await select("alias")).affinity?.status).toBe("created");
  expect((await select("a", crypto.randomUUID())).affinity?.status).toBe(
    "created",
  );
  const identity = await sessionAffinityIdentity(id, sessionId, "alias");
  const affinity = env.SESSION_AFFINITY.getByName(identity.object_name);
  await expect
    .poll(
      async () =>
        (await affinity.getStatus(identity.session_digest))?.index_registered,
    )
    .toBe(true);
  const call = async (method: string, suffix = "") => {
    const url = new URL(`https://gateway.example/sessions${suffix}`);
    const request = new Request(url, { method });
    const response = await handleSessions(
      request,
      env,
      client,
      url,
      suffix.startsWith("/")
        ? { action: "clear", encodedSessionId: encodeURIComponent(sessionId) }
        : { action: "collection" },
      new RequestLogContext("models", request),
    );
    return {
      status: response.status,
      body: await response.json<{
        data: { model: string }[];
        next_cursor: string | null;
        deleted: number;
      }>(),
    };
  };
  const listed: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await call(
      "GET",
      `?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
    );
    listed.push(...page.body.data.map((row) => row.model));
    cursor = page.body.next_cursor;
  } while (cursor);
  expect(listed.sort()).toEqual(["a", "alias", "b"]);
  expect(
    (await call("DELETE", `/${encodeURIComponent(sessionId)}?model=a`)).body
      .deleted,
  ).toBe(1);
  expect((await call("GET")).body.data.map((row) => row.model).sort()).toEqual([
    "alias",
    "b",
  ]);
  for (const query of ["model=", "model=a&model=b"]) {
    expect(
      (await call("DELETE", `/${encodeURIComponent(sessionId)}?${query}`))
        .status,
    ).toBe(400);
  }
  expect(
    (await call("DELETE", `/${encodeURIComponent(sessionId)}`)).body.deleted,
  ).toBe(2);
});
