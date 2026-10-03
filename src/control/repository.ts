import { z } from "zod";
import type { SqlDatabase } from "../platform/bindings.ts";
import {
  entitySchemas,
  entityTables,
  type EntityRows,
  type EntityTable,
} from "./entities.ts";

/** Selected tables remain explicit in the return type; unrequested data is absent. */
export function readEntities(db: SqlDatabase): Promise<EntityRows>;
export function readEntities<K extends EntityTable>(
  db: SqlDatabase,
  tables: readonly K[],
  options?: { includeDeleted?: boolean },
): Promise<Pick<EntityRows, K>>;
export async function readEntities(
  db: SqlDatabase,
  tables: readonly EntityTable[] = entityTables,
  options: { includeDeleted?: boolean } = {},
): Promise<Partial<EntityRows>> {
  const result = await db.batch(
    tables.map((table) =>
      db.prepare(
        `SELECT * FROM ${table}${options.includeDeleted === false && table !== "settings" ? " WHERE deleted_at IS NULL" : ""}`,
      ),
    ),
  );
  const entries = tables.map(
    (table, index) =>
      [
        table,
        z.array(entitySchemas[table]).parse(result[index].results),
      ] as const,
  );
  // Each key and its schema come from the same whitelisted table; no missing tables are synthesized.
  return Object.fromEntries(entries);
}
export const providerTables = [
  "providers",
  "provider_credentials",
  "provider_models",
  "model_routes",
  "model_route_providers",
] as const;
export const clientTables = [
  "clients",
  "client_providers",
  "model_routes",
  "model_route_providers",
] as const;
export const proxyTables = ["proxy_groups", "proxy_nodes"] as const;
export const priceTables = ["provider_models", "model_prices"] as const;
export const routeTables = ["model_routes", "model_route_providers"] as const;
