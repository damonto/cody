import assert from "node:assert/strict";
import { sessionAffinityIdentity } from "../../src/gateway/routing/affinity.ts";
import type { Bindings } from "../../src/platform/bindings.ts";

/** Exercise the same model binding contract against Worker and SQL runtimes. */
export async function sessionModelBindings(
  env: Bindings,
  reopen: (objectName: string) => Promise<Bindings>,
) {
  const clientId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const [a, b, alias] = await Promise.all(
    ["model-a", "model-b", "alias-a"].map((model) =>
      sessionAffinityIdentity(clientId, sessionId, model),
    ),
  );
  assert.equal(a.object_name, b.object_name);
  assert.notEqual(a.session_digest, b.session_digest);
  assert.notEqual(a.session_digest, alias.session_digest);
  const candidates = ["one", "two"].map((provider_id) => ({
    provider_id,
    priority: 1,
    credentials: [{ credential_id: provider_id, priority: 1 }],
  }));
  const one = { provider_id: "one", credential_id: "one" };
  const two = { provider_id: "two", credential_id: "two" };
  let stub = env.SESSION_AFFINITY.getByName(a.object_name);
  const first = await stub.resolve(candidates, two, a);
  const other = await stub.resolve(candidates, one, b);
  assert.ok(first && other);
  const repeated = await stub.resolve(candidates, one, a);
  assert.equal(repeated?.binding_id, first.binding_id);
  assert.equal(repeated?.provider_id, "two");
  assert.equal(
    (await stub.resolve(candidates, one, alias))?.provider_id,
    "one",
  );

  const restored = await reopen(a.object_name);
  stub = restored.SESSION_AFFINITY.getByName(a.object_name);
  assert.equal(
    (await stub.getStatus(a.session_digest))?.binding_id,
    first.binding_id,
  );
  assert.equal(
    (await stub.getStatus(b.session_digest))?.binding_id,
    other.binding_id,
  );
  const rebound = await stub.resolve([candidates[0]], one, a);
  assert.equal(rebound?.status, "rebound");
  assert.equal(
    await stub.clearIfBindingId(
      first.binding_id,
      first.generation,
      a.session_digest,
    ),
    false,
  );
  assert.equal(
    (await stub.getStatus(b.session_digest))?.binding_id,
    other.binding_id,
  );
  const index = restored.SESSION_AFFINITY_INDEX.getByName(b.registry_name);
  await index.remove(b.session_digest, other.binding_id, other.generation);
  await index.register({ ...other, binding_id: "stale-binding" });
  assert.equal((await stub.clearManaged(b)).length, 0);
  assert.equal(
    (await stub.getStatus(b.session_digest))?.binding_id,
    other.binding_id,
  );
  assert.equal(await index.get(b.session_digest), null);
  assert.equal(
    (await stub.getStatus(b.session_digest))?.index_registered,
    false,
  );
  stub = (await reopen(b.object_name)).SESSION_AFFINITY.getByName(
    b.object_name,
  );
  assert.equal(
    (await stub.getStatus(b.session_digest))?.index_registered,
    false,
  );
  assert.equal((await stub.clearManaged(b)).length, 1);
  assert.equal(await stub.getStatus(b.session_digest), null);
  assert.ok(await stub.getStatus(a.session_digest));
  await stub.resolve(candidates, two, b);
  assert.equal(
    await stub.clearIfBindingId(
      other.binding_id,
      other.generation,
      b.session_digest,
    ),
    false,
  );
  assert.equal((await stub.clearManaged(a, true)).length, 3);
}
