import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createSqliteDatabase } from "../src/platform/standard/sql/sqlite.ts";
import {
  postgresDatabase,
  pgliteQueryable,
} from "../src/platform/standard/sql/postgres.ts";
import { checkNativeDefaults } from "./helpers/native-provider-defaults.ts";

for (const dialect of ["sqlite", "postgres"]) {
  test(`${dialect}: native defaults preserve settings and history and allow the first account`, async () => {
    const db =
      dialect === "sqlite"
        ? await createSqliteDatabase(":memory:")
        : postgresDatabase(pgliteQueryable(new PGlite()));
    try {
      const directory = new URL(
        `../migrations/${dialect === "sqlite" ? "d1" : "postgres"}/`,
        import.meta.url,
      );
      const name = "0015_native_provider_defaults.sql";
      for (const migration of (await readdir(directory))
        .filter((item) => item.endsWith(".sql") && item < name)
        .sort())
        await db.exec(await readFile(new URL(migration, directory), "utf8"));
      const sql = await readFile(new URL(name, directory), "utf8");
      await checkNativeDefaults(db, () => db.exec(sql));
    } finally {
      await db.close();
    }
  });
}
