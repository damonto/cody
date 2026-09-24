import { fileURLToPath, URL } from "node:url";
import { connectDatabase } from "./platform/standard/sql/connect.ts";
import {
  applyMigrations,
  migrationDirectories,
} from "./platform/standard/sql/migrate.ts";

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL or DATABASE_MIGRATION_URL is required");
const root = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../" : "./", import.meta.url),
);
const db = await connectDatabase(url, { max: 1 });
try {
  const applied = await applyMigrations(
    db,
    migrationDirectories(db.dialect, root),
  );
  console.info({ event: "database.migrated", applied });
} finally {
  await db.close();
}
