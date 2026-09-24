import type { SqlDialect } from "./bindings.ts";

/**
 * Small SQL rewrites for statements whose text differs between SQLite (D1 and
 * native SQLite) and PostgreSQL. The SQLite text is always the original
 * statement so D1 behavior stays byte-for-byte unchanged.
 */

/** `INSERT INTO ...` that silently skips conflicting rows. */
export function insertIgnore(dialect: SqlDialect, statement: string): string {
  if (dialect === "postgres") return `${statement} ON CONFLICT DO NOTHING`;
  if (!statement.startsWith("INSERT INTO ")) {
    throw new Error(
      "insertIgnore expects a statement starting with INSERT INTO",
    );
  }
  return `INSERT OR IGNORE INTO ${statement.slice("INSERT INTO ".length)}`;
}
