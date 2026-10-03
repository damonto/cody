import { ProviderService } from "../../src/control/services/providers.ts";
import { RoutingService } from "../../src/control/services/routing.ts";
import assert from "node:assert/strict";
import { z } from "zod";
import { ControlStore } from "../../src/control/store.ts";
import { readEntities } from "../../src/control/repository.ts";
import { entityTables } from "../../src/control/entities.ts";
import type { SqlDatabase } from "../../src/platform/bindings.ts";

/** Exercise incremental writes and active-alias constraints on every SQL adapter. */
export async function checkIncrementalConfiguration(
  db: SqlDatabase,
  key: string,
) {
  const store = new ControlStore(db, key);
  const first = await store.save(
    {
      providers: [
        {
          id: "provider",
          name: "Provider",
          type: "ai_gateway",
          base_url: "https://upstream.test/v1",
          priority: 100,
          disabled: false,
          models: ["model"],
          credentials: [
            {
              id: "credential",
              name: "Credential",
              priority: 100,
              disabled: false,
              auth: { type: "api_key", api_key: "upstream-secret" },
            },
          ],
        },
      ],
      api_keys: [
        {
          id: "client",
          name: "Client",
          api_key: "client-secret",
          providers: ["provider"],
        },
      ],
      model_routes: { first: { model: "model" }, second: { model: "model" } },
      model_prices: [
        {
          provider_id: "provider",
          model: "model",
          pricing: {
            currency: "USD",
            tiers: [
              {
                up_to_input_tokens: null,
                input: "1",
                output: "2",
                cache_read: "0",
                cache_write: "0",
              },
            ],
          },
        },
      ],
    },
    0,
    "test",
  );
  const before = await readEntities(db);
  const providers = new ProviderService(store);
  const routing = new RoutingService(store);
  const operation = (version: number) => ({
    version,
    actor: "test",
    operation_id: crypto.randomUUID(),
    request: { test: version },
  });
  const { id, ...provider } = first.config.providers[0];
  assert.equal(provider.type, "ai_gateway");
  if (provider.type !== "ai_gateway") throw new Error("Expected AI Gateway");
  await providers.update(operation(1), id, { ...provider, name: "Renamed" });
  const after = await readEntities(db);
  for (const table of entityTables)
    if (table !== "providers")
      assert.deepEqual(after[table], before[table], table);
  assert.equal(after.providers[0].version, 2);
  assert.equal(after.providers[0].created_at, before.providers[0].created_at);

  const routes = first.config.model_routes;
  const swapped = await routing.save(operation(2), {
    first: routes.second,
    second: routes.first,
  });
  assert.equal(swapped.item.first.id, routes.second.id);
  assert.equal(swapped.item.second.id, routes.first.id);
  assert.deepEqual(await store.current(), await store.revision(3));

  await routing.save(operation(3), { second: swapped.item.second });
  const archived = (await readEntities(db)).model_routes.find(
    (row) => row.id === routes.second.id,
  )!;
  assert.equal(archived.version, 4);
  assert.ok(archived.deleted_at);
  await providers.update(operation(4), id, {
    ...provider,
    name: "Renamed again",
  });
  assert.deepEqual(
    (await readEntities(db)).model_routes.find(
      (row) => row.id === routes.second.id,
    ),
    archived,
  );
  assert.deepEqual(await store.current(), await store.revision(5));

  // Price UUIDs belong to committed snapshots and survive idempotent retries.
  const current = await store.current();
  const operationId = crypto.randomUUID();
  const saved = await store.save(current, 5, "test", operationId);
  assert.deepEqual(await store.save(current, 5, "test", operationId), saved);
  const history = (
    await db
      .prepare(
        "SELECT id, revision, model_price_id, price_json FROM model_price_versions ORDER BY revision",
      )
      .all<{
        id: string;
        revision: number;
        model_price_id: string;
        price_json: string;
      }>()
  ).results;
  assert.deepEqual(
    history.map((row) => row.revision),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(new Set(history.map((row) => row.id)).size, 6);
  for (const row of history) {
    z.uuid().parse(row.id);
    assert.equal(row.model_price_id, first.config.model_prices![0].id);
    assert.equal(JSON.parse(row.price_json).version_id, row.id);
    assert.equal(
      (await store.revision(row.revision)).model_prices![0].version_id,
      row.id,
    );
  }
  // Keep the final schema's uniqueness and foreign keys covered on every backend.
  const duplicate = db.prepare(
    "INSERT INTO model_price_versions (id,revision,model_price_id,price_json,created_at) VALUES (?, 1, ?, '{}', 0)",
  );
  await assert.rejects(
    duplicate.bind(crypto.randomUUID(), history[0].model_price_id).run(),
  );
  await assert.rejects(
    duplicate.bind(crypto.randomUUID(), crypto.randomUUID()).run(),
  );
}
