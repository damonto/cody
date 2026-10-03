import { z } from "zod";
import type { GatewayConfig } from "../config/types.ts";
import type { SqlDatabase } from "../platform/bindings.ts";
import {
  entityTables,
  type EntityRows,
  type EntityTable,
  type SecretVersion,
} from "./entities.ts";

type Row = Record<string, string | number | null>;
interface ConfigurationCommit {
  previous: EntityRows;
  projected: EntityRows;
  snapshot: GatewayConfig;
  secrets: SecretVersion[];
  version: number;
  expectedVersion: number;
  maintenance: number;
  now: number;
  actor: string;
  operationId: string;
  inputHash: string;
  sourceVersion: number | undefined;
}

function primaryKeys(table: EntityTable): string[] {
  switch (table) {
    case "client_providers":
      return ["client_id", "provider_id"];
    case "model_route_providers":
      return ["route_id", "provider_id"];
    case "settings":
      return ["name"];
    default:
      return ["id"];
  }
}

const metadata = new Set(["version", "created_at", "updated_at"]);
function unchanged(before: Row, after: Row): boolean {
  return Object.keys(after).every(
    (column) => metadata.has(column) || before[column] === after[column],
  );
}

/** One fenced SQL transaction owns entities, secrets, snapshot, prices and audit. */
export async function commitConfiguration(
  db: SqlDatabase,
  {
    previous,
    projected,
    snapshot,
    secrets,
    version,
    expectedVersion,
    maintenance,
    now,
    actor,
    operationId,
    inputHash,
    sourceVersion,
  }: ConfigurationCommit,
): Promise<void> {
  const guard =
    "EXISTS (SELECT 1 FROM config_meta WHERE id = 1 AND version = ? AND operation_id = ?)";
  const transactionId = crypto.randomUUID();
  const bindGuard = [version, transactionId];
  const statements = [
    db
      .prepare(
        "UPDATE config_meta SET version = ?, operation_id = ?, updated_at = ? WHERE id = 1 AND version = ? AND maintenance = ?",
      )
      .bind(version, transactionId, now, expectedVersion, maintenance),
  ];
  const upsert = (
    table: string,
    row: Row,
    keys: string[],
    immutable = false,
  ) => {
    const columns = Object.keys(row);
    const updates = columns.filter(
      (key) => !keys.includes(key) && key !== "created_at",
    );
    const conflict = immutable
      ? "DO NOTHING"
      : `DO UPDATE SET ${updates.map((key) => `${key} = excluded.${key}`).join(", ")}`;
    statements.push(
      db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.map(() => "?").join(", ")} WHERE ${guard} ON CONFLICT (${keys.join(", ")}) ${conflict}`,
        )
        .bind(...Object.values(row), ...bindGuard),
    );
  };
  for (const secret of secrets)
    upsert("secret_versions", { ...secret }, ["id"], true);
  const changed: Array<{ table: EntityTable; row: Row; keys: string[] }> = [];
  for (const table of entityTables) {
    const keys = primaryKeys(table);
    const identity = (row: Row) => JSON.stringify(keys.map((key) => row[key]));
    const before = new Map(previous[table].map((row) => [identity(row), row]));
    const retire = (row: Row) => {
      if (row.deleted_at !== null) return;
      const assignments =
        "version" in row
          ? "deleted_at = ?, version = ?, updated_at = ?"
          : "deleted_at = ?";
      const values = "version" in row ? [now, version, now] : [now];
      statements.push(
        db
          .prepare(
            `UPDATE ${table} SET ${assignments} WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")} AND ${guard}`,
          )
          .bind(...values, ...keys.map((key) => row[key]), ...bindGuard),
      );
    };
    for (const row of projected[table]) {
      const old = before.get(identity(row));
      before.delete(identity(row));
      if (old && unchanged(old, row)) continue;
      // Release active aliases before any upsert so names can be swapped atomically.
      if (
        old &&
        table === "model_routes" &&
        "name" in old &&
        "name" in row &&
        old.name !== row.name
      )
        retire(old);
      changed.push({ table, row, keys });
    }
    for (const row of before.values()) retire(row);
  }
  // entityTables is in foreign-key order; inserts retain that order.
  for (const { table, row, keys } of changed) upsert(table, row, keys);
  upsert(
    "config_snapshots",
    {
      version,
      config_json: JSON.stringify(snapshot),
      actor,
      created_at: now,
      source_version: sourceVersion ?? null,
    },
    ["version"],
    true,
  );
  for (const price of snapshot.model_prices ?? [])
    upsert(
      "model_price_versions",
      {
        id: z.uuid().parse(price.version_id),
        revision: version,
        model_price_id: z.uuid().parse(price.id),
        price_json: JSON.stringify(price),
        created_at: now,
      },
      ["id"],
      true,
    );
  upsert(
    "config_operations",
    {
      id: operationId,
      version,
      input_hash: inputHash,
      actor,
      created_at: now,
    },
    ["id"],
    true,
  );
  upsert(
    "audit_log",
    {
      id: operationId,
      created_at: now,
      actor,
      action: sourceVersion ? "restore_configuration" : "save_configuration",
      revision: version,
    },
    ["id"],
    true,
  );
  await db.batch(statements);
}
