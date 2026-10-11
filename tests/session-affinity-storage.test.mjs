import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionAffinityIdentity,
  SESSION_AFFINITY_TTL_MS,
} from "../src/gateway/routing/affinity.ts";
import { SessionAffinityCore } from "../src/gateway/sessions/session-affinity.ts";
import { SessionAffinityIndexCore } from "../src/platform/standard/session-index.ts";
import {
  AlarmState,
  BackedObjectStorage,
  MemoryObjectBackend,
  StandardObjectContext,
} from "../src/platform/standard/objects.ts";

const candidates = [
  {
    provider_id: "provider",
    priority: 1,
    credentials: [{ credential_id: "credential", priority: 1 }],
  },
];

async function fixture() {
  const backend = new MemoryObjectBackend();
  const context = (namespace) =>
    new StandardObjectContext(
      new BackedObjectStorage(
        backend,
        namespace,
        "session",
        new AlarmState(backend, namespace, "session"),
      ),
    );
  const ctx = context("affinity");
  const index = new SessionAffinityIndexCore(context("index"));
  const core = new SessionAffinityCore(ctx, {
    SESSION_AFFINITY_INDEX: { getByName: () => index },
  });
  const [a, b] = await Promise.all(
    ["a", "b"].map((model) =>
      sessionAffinityIdentity("client", "session", model),
    ),
  );
  const resolve = async (identity, options) => {
    const result = await core.resolve(candidates, undefined, identity, options);
    await ctx.drain();
    return result;
  };
  return { core, index, ctx, backend, a, b, resolve };
}

for (const managed of [true, false]) {
  test(`${managed ? "managed" : "conditional"} stale deletion leaves the surviving binding eligible for index repair`, async () => {
    const { core, index, a, resolve } = await fixture();
    const binding = await resolve(a);
    assert.ok(binding);
    await index.remove(
      a.session_digest,
      binding.binding_id,
      binding.generation,
    );
    const stale = { ...binding, binding_id: "stale-binding" };
    await index.register(stale);
    if (managed) {
      assert.deepEqual(await core.clearManaged(a), []);
    } else {
      assert.equal(
        await core.clearIfBindingId(
          stale.binding_id,
          stale.generation,
          a.session_digest,
        ),
        false,
      );
      await index.remove(a.session_digest, stale.binding_id, stale.generation);
    }
    assert.equal(await index.get(a.session_digest), null);
    assert.equal(
      (await core.getStatus(a.session_digest))?.index_registered,
      false,
    );
    assert.equal((await resolve(a))?.binding_id, binding.binding_id);
    assert.equal(
      (await index.get(a.session_digest))?.binding_id,
      binding.binding_id,
    );
  });
}

test("refreshing a later model keeps the nearest alarm without scanning other models", async (t) => {
  const start = 1_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { core, ctx, backend, a, b, resolve } = await fixture();
  await resolve(a);
  t.mock.timers.setTime(start + 1000);
  await resolve(b);
  const scan = t.mock.method(backend, "list");
  t.mock.timers.setTime(start + 2000);
  await resolve(b);
  assert.equal(scan.mock.callCount(), 0);
  assert.equal(await ctx.storage.getAlarm(), start + SESSION_AFFINITY_TTL_MS);

  // Moving the earliest expiry must discover the next model's deadline.
  t.mock.timers.setTime(start + 3000);
  await resolve(a);
  assert.equal(
    await ctx.storage.getAlarm(),
    start + 2000 + SESSION_AFFINITY_TTL_MS,
  );
  await core.clearManaged(b);
  assert.equal(
    await ctx.storage.getAlarm(),
    start + 3000 + SESSION_AFFINITY_TTL_MS,
  );
  await core.clearManaged(a);
  assert.equal(await ctx.storage.getAlarm(), null);
});

test("expiry is evaluated after a queued storage transaction starts", async (t) => {
  const start = 1_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { core, ctx, a, resolve } = await fixture();
  const original = await resolve(a);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const pending = ctx.storage.transaction(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const resolving = core.resolve(candidates, undefined, a);
  t.mock.timers.setTime(start + SESSION_AFFINITY_TTL_MS + 1);
  gate.resolve();
  await pending;
  const replacement = await resolving;
  await ctx.drain();
  assert.equal(replacement?.status, "created");
  assert.notEqual(replacement?.binding_id, original?.binding_id);
});
