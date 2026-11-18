import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "../src/platform/standard/sql/migrate.ts";
import { createTestPostgresDatabase } from "./helpers/postgres.mjs";
import { checkNativeDefaults } from "./helpers/native-provider-defaults.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const dialect of ["sqlite", "postgres"]) {
  test(`${dialect}: native defaults preserve settings and history and allow the first account`, async (t) => {
    const db =
      dialect === "sqlite"
        ? await createSqliteDatabase(":memory:")
        : createTestPostgresDatabase();
    t.after(() => db.close());
    await checkNativeDefaults(db, () =>
      applyMigrations(db, migrationDirectories(dialect, root)),
    );
  });
}
