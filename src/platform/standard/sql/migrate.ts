import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SqlDatabase, SqlDialect } from "../../bindings.ts";

export interface MigratableDatabase extends SqlDatabase {
  exec(script: string): Promise<void>;
  applyMigration(script: string, name: string): Promise<boolean>;
  /** Runs migrations on the connection holding the PostgreSQL transaction lock. */
  withMigrationLock?<T>(
    operation: (locked: MigratableDatabase) => Promise<T>,
  ): Promise<T>;
}

/**
 * Migration directories for a dialect, relative to the project (or bundle)
 * root. SQLite reuses migrations/d1 and adds migrations/sqlite; PostgreSQL
 * uses migrations/postgres. Standard-backend-only tables start at 1001.
 */
export function migrationDirectories(
  dialect: SqlDialect,
  root: string,
): string[] {
  return dialect === "postgres"
    ? [path.join(root, "migrations", "postgres")]
    : [
        path.join(root, "migrations", "d1"),
        path.join(root, "migrations", "sqlite"),
      ];
}

async function migrationFiles(
  directories: readonly string[],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const directory of directories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
      if (files.has(entry.name)) {
        throw new Error(`Duplicate migration name ${entry.name}`);
      }
      files.set(entry.name, path.join(directory, entry.name));
    }
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Applies unapplied `*.sql` files in name order; returns the names applied. */
export async function applyMigrations(
  db: MigratableDatabase,
  directories: readonly string[],
): Promise<string[]> {
  const run = async (db: MigratableDatabase): Promise<string[]> => {
    await db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
    );
    const applied = new Set(
      (
        await db
          .prepare("SELECT name FROM schema_migrations")
          .all<{ name: string }>()
      ).results.map((row) => row.name),
    );
    const executed: string[] = [];
    for (const [name, file] of await migrationFiles(directories)) {
      if (applied.has(name)) continue;
      if (await db.applyMigration(await readFile(file, "utf8"), name))
        executed.push(name);
    }
    return executed;
  };
  return db.withMigrationLock ? db.withMigrationLock(run) : run(db);
}
