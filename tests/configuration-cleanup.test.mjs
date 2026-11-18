import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import { createTestPostgresDatabase } from "./helpers/postgres.mjs";
import {
  checkConfigurationCleanup,
  configurationTables,
  retiredConfigurationTables,
} from "./helpers/configuration-cleanup.ts";

const name = "0012_entity_configuration.sql";
for (const dialect of ["sqlite", "postgres"]) {
  test(`${dialect}: entity initialization retires document tables and preserves history atomically`, async () => {
    const db =
      dialect === "sqlite"
        ? await createSqliteDatabase(":memory:")
        : createTestPostgresDatabase();
    try {
      const directory = new URL(
        `../migrations/${dialect === "sqlite" ? "d1" : "postgres"}/`,
        import.meta.url,
      );
      await db.exec(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
      );
      for (const migration of (await readdir(directory))
        .filter((entry) => entry.endsWith(".sql") && entry < name)
        .sort())
        await db.applyMigration(
          await readFile(new URL(migration, directory), "utf8"),
          migration,
        );
      const sql = await readFile(new URL(name, directory), "utf8");
      const apply = () => db.applyMigration(sql, name);
      await checkConfigurationCleanup(db, apply);
      assert.equal(await apply(), false);
    } finally {
      await db.close();
    }
  });
}

test("fresh SQLite databases apply the full migration history without the retired converter", async () => {
  const db = await createSqliteDatabase(":memory:");
  try {
    const directory = new URL("../migrations/d1/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((entry) => entry.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(new URL(name, directory), "utf8"));
    const tables = await configurationTables(db);
    for (const table of retiredConfigurationTables)
      assert.ok(!tables.has(table));
    assert.ok(tables.has("settings"));
    assert.ok(!tables.has("configuration_settings"));
    assert.equal(
      (await db.prepare("SELECT version FROM config_meta").first()).version,
      0,
    );
  } finally {
    await db.close();
  }
});

test("the legacy seed migration leaves a provider with an OAuth account for manual cleanup", async (t) => {
  const db = await createSqliteDatabase(":memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/d1/", import.meta.url);
  const name = "0019_remove_antigravity_seed.sql";
  for (const migration of (await readdir(directory))
    .filter((entry) => entry.endsWith(".sql") && entry < name)
    .sort())
    await db.exec(await readFile(new URL(migration, directory), "utf8"));
  const provider = await db
    .prepare("SELECT * FROM providers WHERE type = 'antigravity'")
    .first();
  const ref = crypto.randomUUID();
  await db
    .prepare("INSERT INTO oauth_accounts VALUES (?, ?, 'antigravity', 0)")
    .bind(ref, provider.id)
    .run();

  await db.exec(await readFile(new URL(name, directory), "utf8"));

  assert.deepEqual(
    await db
      .prepare("SELECT * FROM providers WHERE id = ?")
      .bind(provider.id)
      .first(),
    provider,
  );
  const account = await db
    .prepare("SELECT provider_id FROM oauth_accounts WHERE account_ref = ?")
    .bind(ref)
    .first();
  assert.equal(account.provider_id, provider.id);
  await db
    .prepare("DELETE FROM oauth_accounts WHERE account_ref = ?")
    .bind(ref)
    .run();
  await db
    .prepare("DELETE FROM providers WHERE id = ?")
    .bind(provider.id)
    .run();
});
