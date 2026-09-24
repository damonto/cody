/**
 * `SqlDatabase` over PostgreSQL. The application writes `?` placeholders; this
 * adapter numbers them. `pg` pools are used in production; tests may plug in
 * any object with the `PostgresQueryable` shape (for example PGlite).
 */
import type { Pool } from "pg";
import { logWarn } from "../../../shared/log.ts";
import type { SqlResult, SqlStatement } from "../../bindings.ts";
import type { MigratableDatabase } from "./migrate.ts";

export interface PostgresQueryResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
}

export interface PostgresQueryable {
  query(text: string, params: readonly unknown[]): Promise<PostgresQueryResult>;
  exec(script: string): Promise<void>;
  transaction<T>(fn: (tx: PostgresQueryable) => Promise<T>): Promise<T>;
}

export interface PostgresDatabase extends MigratableDatabase {
  readonly dialect: "postgres";
  exec(script: string): Promise<void>;
  close(): Promise<void>;
  applyMigration(script: string, name: string): Promise<boolean>;
}

/** Rewrites `?` placeholders to `$1..$n`, ignoring `?` inside string literals. */
export function numberPlaceholders(sql: string): string {
  let output = "";
  let index = 0;
  let quoted = false;
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    if (char === "?" && !quoted) {
      index += 1;
      output += `$${index}`;
    } else {
      output += char;
    }
  }
  return output;
}

function bindValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean" ||
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

class PostgresStatement implements SqlStatement {
  readonly text: string;
  constructor(
    private readonly queryable: PostgresQueryable,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {
    this.text = numberPlaceholders(sql);
  }

  bind(...values: unknown[]): SqlStatement {
    return new PostgresStatement(this.queryable, this.sql, values);
  }

  async execute<T>(queryable: PostgresQueryable): Promise<SqlResult<T>> {
    const result = await queryable.query(this.text, this.values.map(bindValue));
    return {
      results: result.rows.map((row) => normalizeRow<T>(row)),
      meta: { changes: result.rowCount },
    };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { results } = await this.execute<T>(this.queryable);
    return results[0] ?? null;
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.execute<T>(this.queryable);
  }

  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.execute<T>(this.queryable);
  }
}

export function postgresDatabase(
  queryable: PostgresQueryable,
  close: () => Promise<void> = async () => {},
): PostgresDatabase {
  return {
    dialect: "postgres",
    prepare(query: string): SqlStatement {
      return new PostgresStatement(queryable, query);
    },
    batch<T = Record<string, unknown>>(
      statements: SqlStatement[],
    ): Promise<SqlResult<T>[]> {
      return queryable.transaction(async (tx) => {
        const results: SqlResult<T>[] = [];
        for (const statement of statements) {
          if (!(statement instanceof PostgresStatement)) {
            throw new TypeError("batch expects statements from this database");
          }
          results.push(await statement.execute<T>(tx));
        }
        return results;
      });
    },
    exec: (script) => queryable.exec(script),
    applyMigration: (script, name) =>
      queryable.transaction(async (tx) => {
        const applied = await tx.query(
          "SELECT name FROM schema_migrations WHERE name = $1",
          [name],
        );
        if (applied.rows.length) return false;
        await tx.exec(script);
        await tx.query(
          "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)",
          [name, Date.now()],
        );
        return true;
      }),
    close,
  };
}

interface PgClientLike {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

function pgQueryable(client: PgClientLike): PostgresQueryable {
  return {
    async query(text, params) {
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async exec(script) {
      await client.query(script);
    },
    async transaction(fn) {
      await client.query("BEGIN");
      try {
        const result = await fn(pgQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
}

// Arbitrary constant shared by every Cody instance migrating the same database.
const MIGRATION_LOCK_ID = 727_274_001;

export interface PostgresOptions {
  /** Maximum pooled connections per process. */
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  /** Receives the `pg` pool, for example to register it with the platform. */
  readonly onPool?: (pool: Pool) => void;
}

export async function createPostgresDatabase(
  url: string,
  options: PostgresOptions = {},
): Promise<PostgresDatabase> {
  const pg = await import("pg");
  const { Pool, types } = pg.default;
  // Epoch-millisecond timestamps and counters fit JavaScript numbers.
  const pool = new Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: 5_000,
    types: {
      getTypeParser(oid, format) {
        if ((oid === 20 || oid === 1700) && format !== "binary") return Number;
        return types.getTypeParser(oid, format);
      },
    },
  });
  // An idle client error (for example a server restart) must not crash the process.
  pool.on("error", () => logWarn("postgres.pool.idle_connection_failed"));
  options.onPool?.(pool);
  const queryable: PostgresQueryable = {
    async query(text, params) {
      const result = await pool.query(text, [...params]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async exec(script) {
      const client = await pool.connect();
      try {
        await client.query(script);
      } finally {
        client.release();
      }
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        return await pgQueryable(client).transaction(fn);
      } finally {
        client.release();
      }
    },
  };
  return {
    ...postgresDatabase(queryable, () => pool.end()),
    async withMigrationLock(operation) {
      return queryable.transaction(async (tx) => {
        await tx.exec("SET LOCAL lock_timeout = '60s'");
        await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
        // Keep the lock, schema changes and history on one transaction/connection,
        // including when DATABASE_URL points to a transaction-mode pooler.
        return operation(
          postgresDatabase({
            ...tx,
            transaction: (fn) => fn(tx),
          }),
        );
      });
    },
  };
}

interface PgliteLike {
  query(
    text: string,
    params?: readonly unknown[],
    options?: { parsers?: Record<number, (value: string) => unknown> },
  ): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(script: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
}

// INT8 and NUMERIC (for example SUM over BIGINT) arrive as strings otherwise.
const NUMERIC_PARSERS = {
  20: (value: string) => Number(value),
  1700: (value: string) => Number(value),
};

/** Wraps an `@electric-sql/pglite` instance (tests and local development). */
export function pgliteQueryable(pglite: PgliteLike): PostgresQueryable {
  return {
    async query(text, params) {
      const result = await pglite.query(text, [...params], {
        parsers: NUMERIC_PARSERS,
      });
      return {
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
    async exec(script) {
      await pglite.exec(script);
    },
    transaction(fn) {
      return pglite.transaction((tx) =>
        fn({
          ...pgliteQueryable(tx),
          transaction: (inner) => inner(pgliteQueryable(tx)),
        }),
      );
    },
  };
}
