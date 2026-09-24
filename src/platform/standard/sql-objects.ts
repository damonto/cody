/**
 * Object storage in SQL for state that must survive restarts and Redis
 * eviction (OAuth accounts, session ownership, publication intents). The
 * tables are created by the standard-backend migrations, never on D1.
 */
import type { SqlDatabase, SqlStatement } from "../bindings.ts";
import type { ObjectListOptions } from "../object-context.ts";
import type { ObjectBackend, ObjectChange } from "./objects.ts";

// Keys in this codebase are ASCII; U+FFFF bounds every key with the prefix.
const PREFIX_END = String.fromCharCode(0xffff);

export class SqlObjectBackend implements ObjectBackend {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: SqlDatabase,
    private version?: string,
  ) {}

  async scope(namespace: string, name: string): Promise<ObjectBackend> {
    await this.db
      .prepare(
        "INSERT INTO object_versions (namespace, object_name, version) VALUES (?, ?, ?) ON CONFLICT (namespace, object_name) DO NOTHING",
      )
      .bind(namespace, name, crypto.randomUUID())
      .run();
    const row = await this.db
      .prepare(
        "SELECT version FROM object_versions WHERE namespace = ? AND object_name = ?",
      )
      .bind(namespace, name)
      .first<{ version: string }>();
    if (!row) throw new Error("Object storage revision is missing");
    return new SqlObjectBackend(this.db, row.version);
  }

  async get(
    namespace: string,
    name: string,
    key: string,
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        "SELECT item_value FROM object_storage WHERE namespace = ? AND object_name = ? AND item_key = ?",
      )
      .bind(namespace, name, key)
      .first<{ item_value: string }>();
    return row?.item_value ?? null;
  }

  async list(
    namespace: string,
    name: string,
    options: ObjectListOptions,
  ): Promise<[string, string][]> {
    const conditions = ["namespace = ?", "object_name = ?"];
    const values: unknown[] = [namespace, name];
    if (options.prefix !== undefined && options.prefix !== "") {
      conditions.push("item_key >= ?", "item_key < ?");
      values.push(options.prefix, `${options.prefix}${PREFIX_END}`);
    }
    if (options.startAfter !== undefined) {
      conditions.push("item_key > ?");
      values.push(options.startAfter);
    }
    let query = `SELECT item_key, item_value FROM object_storage WHERE ${conditions.join(" AND ")} ORDER BY item_key`;
    if (options.limit !== undefined) {
      query += " LIMIT ?";
      values.push(options.limit);
    }
    const { results } = await this.db
      .prepare(query)
      .bind(...values)
      .all<{ item_key: string; item_value: string }>();
    return results.map((row) => [row.item_key, row.item_value]);
  }

  commit(namespace: string, name: string, change: ObjectChange): Promise<void> {
    const result = this.writes.then(() => this.apply(namespace, name, change));
    // A failed CAS poisons the invocation; later writes must also fail.
    this.writes = result;
    void result.catch(() => undefined);
    return result;
  }

  private async apply(
    namespace: string,
    name: string,
    change: ObjectChange,
  ): Promise<void> {
    const statements: SqlStatement[] = [];
    const nextVersion = crypto.randomUUID();
    const guard =
      this.version === undefined
        ? "1 = 1"
        : "EXISTS (SELECT 1 FROM object_versions WHERE namespace = ? AND object_name = ? AND version = ?)";
    const guardValues =
      this.version === undefined ? [] : [namespace, name, nextVersion];
    if (this.version !== undefined) {
      statements.push(
        this.db
          .prepare(
            "UPDATE object_versions SET version = ? WHERE namespace = ? AND object_name = ? AND version = ?",
          )
          .bind(nextVersion, namespace, name, this.version),
      );
    }
    if (change.clear) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM object_storage WHERE namespace = ? AND object_name = ? AND ${guard}`,
          )
          .bind(namespace, name, ...guardValues),
      );
    }
    for (const key of change.deletes) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM object_storage WHERE namespace = ? AND object_name = ? AND item_key = ? AND ${guard}`,
          )
          .bind(namespace, name, key, ...guardValues),
      );
    }
    for (const [key, value] of change.puts) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO object_storage (namespace, object_name, item_key, item_value) SELECT ?, ?, ?, ? WHERE ${guard} ON CONFLICT (namespace, object_name, item_key) DO UPDATE SET item_value = excluded.item_value`,
          )
          .bind(namespace, name, key, value, ...guardValues),
      );
    }
    if (change.alarm === null) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM object_alarms WHERE namespace = ? AND object_name = ? AND ${guard}`,
          )
          .bind(namespace, name, ...guardValues),
      );
    } else if (change.alarm !== undefined) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO object_alarms (namespace, object_name, scheduled_at) SELECT ?, ?, ? WHERE ${guard} ON CONFLICT (namespace, object_name) DO UPDATE SET scheduled_at = excluded.scheduled_at`,
          )
          .bind(namespace, name, Math.floor(change.alarm), ...guardValues),
      );
    }
    if (statements.length > 0) {
      const results = await this.db.batch(statements);
      if (this.version !== undefined) {
        if (results[0]?.meta.changes !== 1)
          throw new Error("Stale object storage write rejected");
        this.version = nextVersion;
      }
    }
  }

  async getAlarm(namespace: string, name: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        "SELECT scheduled_at FROM object_alarms WHERE namespace = ? AND object_name = ?",
      )
      .bind(namespace, name)
      .first<{ scheduled_at: number }>();
    return row ? Number(row.scheduled_at) : null;
  }

  async dueAlarms(
    namespace: string,
    now: number,
    limit: number,
  ): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        "SELECT object_name FROM object_alarms WHERE namespace = ? AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?",
      )
      .bind(namespace, Math.floor(now), limit)
      .all<{ object_name: string }>();
    return results.map((row) => row.object_name);
  }
}
