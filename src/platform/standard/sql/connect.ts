import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createLibsqlDatabase, type LibsqlDatabase } from "./libsql.ts";
import { createPostgresDatabase, type PostgresOptions } from "./postgres.ts";
import type { SqliteDatabase } from "./sqlite.ts";
import type { PostgresDatabase } from "./postgres.ts";

/** Identifies the database behind a `DATABASE_URL` from its scheme. */
export function databaseKind(url: string): "sqlite" | "libsql" | "postgres" {
  if (/^postgres(?:ql)?:\/\//.test(url)) return "postgres";
  if (url.startsWith("libsql://")) return "libsql";
  if (url.startsWith("sqlite:")) return "sqlite";
  throw new Error("DATABASE_URL must use sqlite:, libsql:// or postgres://");
}

/** Opens a SQL database without requiring Redis or administrator settings. */
export async function connectDatabase(
  url: string,
  options: PostgresOptions = {},
): Promise<SqliteDatabase | LibsqlDatabase | PostgresDatabase> {
  const kind = databaseKind(url);
  if (kind === "postgres") return createPostgresDatabase(url, options);
  if (kind === "libsql") return createLibsqlDatabase(url);
  const filename = url.slice("sqlite:".length);
  if (!filename) throw new Error("SQLite database path is missing");
  if (filename !== ":memory:") {
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const { createSqliteDatabase } = await import("./sqlite.ts");
  return createSqliteDatabase(filename);
}
