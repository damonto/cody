import {
  newAntigravityProvider,
  newCodexProvider,
  newClaudeProvider,
  newXaiProvider,
} from "./native-provider-fixtures.ts";
import assert from "node:assert/strict";
import { z } from "zod";
import type { SqlDatabase } from "../../src/platform/bindings.ts";
import { ControlStore } from "../../src/control/store.ts";
import { ProviderService } from "../../src/control/services/providers.ts";

const nativeDefaults = () => [
  newAntigravityProvider(),
  newCodexProvider(),
  newClaudeProvider(),
  newXaiProvider(),
];

export async function checkNativeDefaults(
  db: SqlDatabase,
  migrate: () => Promise<unknown>,
) {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const store = new ControlStore(db, key);
  const service = new ProviderService(store);
  await migrate();
  const initial = (await service.list()).item;
  assert.equal(initial.length, 4);
  const defaults = nativeDefaults();
  for (const [index, provider] of initial.entries()) {
    z.uuid().parse(provider.id);
    assert.deepEqual(provider, {
      ...defaults[index],
      id: provider.id,
      model_settings: {},
      model_routes: {},
    });
  }
  assert.equal(new Set(initial.map((provider) => provider.id)).size, 4);
  await migrate();
  assert.deepEqual((await service.list()).item, initial);

  // Simulate an existing installation with one customized singleton and archived history.
  const saved = await store.save(
    {
      providers: [
        {
          ...initial[0],
          name: "Custom",
          priority: 77,
          account_selection: "session_affinity",
        },
      ],
      api_keys: [],
    },
    0,
    "test",
  );
  const before = await db
    .prepare("SELECT * FROM providers ORDER BY position")
    .all();
  const snapshots = (await db.prepare("SELECT * FROM config_snapshots").all())
    .results;
  await migrate();
  const after = await db
    .prepare("SELECT * FROM providers ORDER BY position")
    .all();
  for (const row of before.results)
    assert.deepEqual(
      after.results.find((candidate) => candidate.id === row.id),
      row,
    );
  const supplemented = (await service.list()).item;
  assert.equal(supplemented.length, 4);
  assert.equal(supplemented[0].name, "Custom");
  assert.deepEqual(
    supplemented.map((provider) => provider.type),
    defaults.map((provider) => provider.type),
  );
  assert.deepEqual(
    (await db.prepare("SELECT * FROM config_snapshots").all()).results,
    snapshots,
  );
  assert.deepEqual(await store.current(), saved.config);
  await migrate();
  assert.deepEqual((await service.list()).item, supplemented);

  // Adding credentials directly must compile the seeded providers without enabling them.
  for (const provider of supplemented) {
    const ref = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO oauth_accounts(account_ref,provider_id,provider_type,created_at) VALUES (?,?,?,?)",
      )
      .bind(ref, provider.id, provider.type, Date.now())
      .run();
    const { version } = await store.state();
    const credential = {
      name: "First account",
      priority: 100,
      disabled: false,
      auth: { type: "oauth" as const, account_ref: ref },
    };
    await service.createCredential(
      {
        version,
        actor: "test",
        operation_id: crypto.randomUUID(),
        request: credential,
      },
      provider.id,
      credential,
    );
    const current = (await store.current()).providers.find(
      (item) => item.id === provider.id,
    )!;
    assert.equal(current.disabled, true);
    assert.deepEqual(current.credentials[0].auth, {
      type: "oauth",
      account_ref: ref,
    });
  }
  assert.deepEqual(
    (await db.prepare("SELECT * FROM config_snapshots WHERE version = 1").all())
      .results,
    snapshots,
  );
}
