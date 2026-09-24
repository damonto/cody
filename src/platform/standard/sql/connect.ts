import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createPostgresDatabase, type PostgresOptions } from "./postgres.ts";
import type { SqliteDatabase } from "./sqlite.ts";
import type { PostgresDatabase } from "./postgres.ts";

/** Opens a SQL database without requiring Redis or administrator settings. */
export async function connectDatabase(
  url: string,
  options: PostgresOptions = {},
): Promise<SqliteDatabase | PostgresDatabase> {
  if (/^postgres(?:ql)?:\/\//.test(url))
    return createPostgresDatabase(url, options);
  if (!url.startsWith("sqlite:"))
    throw new Error("DATABASE_URL must use sqlite: or postgres://");
  const filename = url.slice("sqlite:".length);
  if (!filename) throw new Error("SQLite database path is missing");
  if (filename !== ":memory:") {
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const { createSqliteDatabase } = await import("./sqlite.ts");
  return createSqliteDatabase(filename);
}
