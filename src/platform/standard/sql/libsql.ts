/**
 * `SqlDatabase` over a remote libSQL server (Turso or self-hosted `sqld`)
 * through the HTTP client, which has no native bindings and suits serverless
 * functions. libSQL is SQLite, so it reuses the SQLite statements and
 * migrations; `batch()` runs every statement in one write transaction.
 */
import type {
  Client,
  InStatement,
  InValue,
  ResultSet,
} from "@libsql/client/http";
import type { SqlResult, SqlStatement } from "../../bindings.ts";
import type { MigratableDatabase } from "./migrate.ts";

export interface LibsqlDatabase extends MigratableDatabase {
  readonly dialect: "sqlite";
  close(): void;
}

function bindValue(value: unknown): InValue {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function sqlResult<T>(result: ResultSet): SqlResult<T> {
  const results = result.rows.map(
    (row) =>
      Object.fromEntries(
        result.columns.map((column, index) => [column, row[index]]),
      ) as T,
  );
  // The server's change count is undefined for statements that return rows;
  // report the row count there, as the SQLite adapter does.
  return {
    results,
    meta: {
      changes: result.columns.length > 0 ? results.length : result.rowsAffected,
    },
  };
}

class LibsqlStatement implements SqlStatement {
  readonly statement: InStatement;

  constructor(
    private readonly client: Client,
    readonly sql: string,
    values: readonly unknown[] = [],
  ) {
    this.statement = { sql, args: values.map(bindValue) };
  }

  bind(...values: unknown[]): SqlStatement {
    return new LibsqlStatement(this.client, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { results } = await this.all<T>();
    return results[0] ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return sqlResult<T>(await this.client.execute(this.statement));
  }

  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.all<T>();
  }
}

export function libsqlDatabase(client: Client): LibsqlDatabase {
  return {
    dialect: "sqlite",
    prepare(query: string): SqlStatement {
      return new LibsqlStatement(client, query);
    },
    async batch<T = Record<string, unknown>>(
      statements: SqlStatement[],
    ): Promise<SqlResult<T>[]> {
      const results = await client.batch(
        statements.map((statement) => {
          if (!(statement instanceof LibsqlStatement)) {
            throw new TypeError("batch expects statements from this database");
          }
          return statement.statement;
        }),
        "write",
      );
      return results.map((result) => sqlResult<T>(result));
    },
    async exec(script: string): Promise<void> {
      await client.executeMultiple(script);
    },
    async applyMigration(script: string, name: string): Promise<boolean> {
      // BEGIN IMMEDIATE serializes concurrent migrators, as on SQLite.
      const transaction = await client.transaction("write");
      try {
        const applied = await transaction.execute({
          sql: "SELECT name FROM schema_migrations WHERE name = ?",
          args: [name],
        });
        if (applied.rows.length === 0) {
          await transaction.executeMultiple(script);
          await transaction.execute({
            sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
            args: [name, Date.now()],
          });
        }
        await transaction.commit();
        return applied.rows.length === 0;
      } finally {
        // Rolls back on the server unless the commit succeeded.
        transaction.close();
      }
    },
    close(): void {
      client.close();
    },
  };
}

export async function createLibsqlDatabase(
  url: string,
): Promise<LibsqlDatabase> {
  const { createClient } = await import("@libsql/client/http");
  return libsqlDatabase(createClient({ url }));
}
