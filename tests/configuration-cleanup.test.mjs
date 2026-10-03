import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  postgresDatabase,
  pgliteQueryable,
} from "../src/platform/standard/sql/postgres.ts";
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
        : postgresDatabase(pgliteQueryable(new PGlite()));
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
