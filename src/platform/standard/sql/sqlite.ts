/**
 * `SqlDatabase` over Node's built-in `node:sqlite`. Statements are immutable
 * like D1's: `bind()` returns a new statement, and `batch()` runs every
 * statement inside one transaction.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase, SqlResult, SqlStatement } from "../../bindings.ts";

export interface SqliteDatabase extends SqlDatabase {
  readonly dialect: "sqlite";
  exec(script: string): Promise<void>;
  applyMigration(script: string, name: string): Promise<boolean>;
  close(): void;
}

function bindValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function normalizeRow<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return result as T;
}

function returnsRows(sql: string): boolean {
  const head = sql.trimStart().slice(0, 6).toUpperCase();
  return (
    head.startsWith("SELECT") ||
    head.startsWith("WITH") ||
    head.startsWith("PRAGMA") ||
    /\bRETURNING\b/i.test(sql)
  );
}

class SqliteStatement implements SqlStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new SqliteStatement(this.database, this.sql, values);
  }

  private prepared() {
    const statement = this.database.prepare(this.sql);
    return {
      statement,
      params: this.values.map(bindValue),
    };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { statement, params } = this.prepared();
    const row = statement.get(...params) as Record<string, unknown> | undefined;
    return row === undefined ? null : normalizeRow<T>(row);
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.execute<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.execute<T>();
  }

  /** Synchronous core shared with `batch`, which must not yield mid-transaction. */
  execute<T = Record<string, unknown>>(): SqlResult<T> {
    const { statement, params } = this.prepared();
    if (returnsRows(this.sql)) {
      const results = (
        statement.all(...params) as Record<string, unknown>[]
      ).map((row) => normalizeRow<T>(row));
      return { results, meta: { changes: results.length } };
    }
    const info = statement.run(...params);
    return { results: [], meta: { changes: Number(info.changes) } };
  }
}

export async function createSqliteDatabase(
  path: string,
): Promise<SqliteDatabase> {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
  }
  return {
    dialect: "sqlite",
    prepare(query: string): SqlStatement {
      return new SqliteStatement(database, query);
    },
    async batch<T = Record<string, unknown>>(
      statements: SqlStatement[],
    ): Promise<SqlResult<T>[]> {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof SqliteStatement)) {
            throw new TypeError("batch expects statements from this database");
          }
          return statement.execute<T>();
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(script: string): Promise<void> {
      database.exec(script);
    },
    async applyMigration(script: string, name: string): Promise<boolean> {
      database.exec("BEGIN IMMEDIATE");
      try {
        const applied = database
          .prepare("SELECT name FROM schema_migrations WHERE name = ?")
          .get(name);
        if (!applied) {
          database.exec(script);
          database
            .prepare(
              "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
            )
            .run(name, Date.now());
        }
        database.exec("COMMIT");
        return !applied;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close(): void {
      database.close();
    },
  };
}
