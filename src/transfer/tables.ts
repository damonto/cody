import { sqlDialect, type SqlDatabase } from "../platform/bindings.ts";
import {
  TABLES,
  TABLE_KEYS,
  PAGE_SIZE,
  MAX_TRANSFER_BYTES,
  TransferError,
  hash,
  rowSchema,
  type TransferTable,
  type TransferRow,
} from "./protocol.ts";

export interface Column {
  name: string;
  kind: "text" | "integer" | "real";
}
export type TableLayout = Record<TransferTable, Column[]>;
const identifier = /^[a-z][a-z0-9_]*$/;

/** Read only declared business tables. Integer text avoids every driver's int64 coercion. */
export async function tableLayout(db: SqlDatabase): Promise<TableLayout> {
  const allowed = new Set<string>([
    ...TABLES,
    "schema_migrations",
    "d1_migrations",
    "sqlite_sequence",
    "object_storage",
    "object_versions",
    "object_alarms",
    "oauth_host_identity",
  ]);
  const existing = (
    await db
      .prepare(
        sqlDialect(db) === "postgres"
          ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
          : "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .all<{ name: string }>()
  ).results;
  if (
    existing.some(
      ({ name }) =>
        !allowed.has(name) &&
        !(
          sqlDialect(db) !== "postgres" &&
          (name.startsWith("_cf_") || name.startsWith("sqlite_"))
        ),
    )
  )
    throw new TransferError(
      "Unrecognized database schema; use the same current release on both instances",
    );
  const result = {} as TableLayout;
  for (const table of TABLES) {
    const rows =
      sqlDialect(db) === "postgres"
        ? (
            await db
              .prepare(
                "SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
              )
              .bind(table)
              .all<{ name: string; type: string }>()
          ).results
        : (
            await db
              .prepare(`PRAGMA table_info(${table})`)
              .all<{ name: string; type: string }>()
          ).results;
    if (!rows.length)
      throw new TransferError(
        `Missing table: ${table}; apply migrations first`,
      );
    result[table] = rows.map(({ name, type }) => {
      if (!identifier.test(name))
        throw new TransferError(`Unsupported column in ${table}`);
      const kind = /int/i.test(type)
        ? "integer"
        : /real|double|float/i.test(type)
          ? "real"
          : /text|character/i.test(type)
            ? "text"
            : null;
      if (!kind) throw new TransferError(`Unsupported column type in ${table}`);
      return { name, kind };
    });
  }
  return result;
}

export async function readPage(
  db: SqlDatabase,
  layout: TableLayout,
  table: TransferTable,
  cursor: (string | number)[] | null,
  limit = PAGE_SIZE,
) {
  const columns = layout[table];
  const keys = TABLE_KEYS[table];
  if (cursor && cursor.length !== keys.length)
    throw new TransferError("Invalid page cursor", 400);
  const select = columns
    .map(({ name, kind }) =>
      kind === "integer" ? `CAST(${name} AS TEXT) AS ${name}` : name,
    )
    .join(", ");
  // Explicit collations keep text key ordering identical on every platform.
  const key = (name: string) =>
    columns.find((c) => c.name === name)?.kind === "text"
      ? `${name} COLLATE ${sqlDialect(db) === "postgres" ? '"C"' : "BINARY"}`
      : name;
  const parameter = (name: string) =>
    columns.find((c) => c.name === name)?.kind === "integer"
      ? `CAST(? AS ${sqlDialect(db) === "postgres" ? "BIGINT" : "INTEGER"})`
      : "?";
  const comparison =
    keys.length === 1
      ? `${key(keys[0])} > ${parameter(keys[0])}`
      : `(${keys.map(key).join(",")}) > (${keys.map(parameter).join(",")})`;
  const rows = (
    await db
      .prepare(
        `SELECT ${select} FROM ${table}${cursor ? ` WHERE ${comparison}` : ""} ORDER BY ${keys.map(key).join(",")} LIMIT ${limit + 1}`,
      )
      .bind(...(cursor ?? []))
      .all()
  ).results.map((row) => rowSchema.parse(row));
  let bytes = 0;
  const page: TransferRow[] = [];
  for (const row of rows.slice(0, limit)) {
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (size > MAX_TRANSFER_BYTES / 2)
      throw new TransferError(`A ${table} row exceeds the transfer limit`);
    if (page.length && bytes + size > MAX_TRANSFER_BYTES / 2) break;
    page.push(row);
    bytes += size;
  }
  const last = page.at(-1);
  const next =
    last && page.length < rows.length
      ? keys.map((k) => {
          const value = last[k];
          if (value === null) throw new TransferError("Null primary key");
          return value;
        })
      : null;
  return {
    rows: page,
    next_cursor: next,
    digest: await hash({ table, cursor, rows: page, next_cursor: next }),
  };
}

export function validateRows(
  layout: TableLayout,
  table: TransferTable,
  rows: TransferRow[],
): void {
  for (const row of rows) {
    if (Object.keys(row).length !== layout[table].length)
      throw new TransferError(`Invalid ${table} columns`, 400);
    for (const { name, kind } of layout[table]) {
      const value = row[name];
      if (value === null) continue;
      if (
        kind === "integer"
          ? typeof value !== "string" || !/^-?\d+$/.test(value)
          : kind === "text"
            ? typeof value !== "string"
            : typeof value !== "number" || !Number.isFinite(value)
      )
        throw new TransferError(`Invalid ${table}.${name}`, 400);
    }
  }
}

/** A freshly migrated target has only four untouched native-provider seeds. */
export async function requireEmptyTarget(
  db: SqlDatabase,
  prepared = false,
): Promise<void> {
  const meta = await db
    .prepare(
      "SELECT version, operation_id, maintenance, updated_at FROM config_meta WHERE id = 1",
    )
    .first();
  if (
    !meta ||
    meta.version !== 0 ||
    meta.operation_id !== null ||
    meta.updated_at !== 0 ||
    meta.maintenance !== 0
  )
    throw new TransferError("Target has already been configured");
  for (const table of TABLES.filter(
    (t) => t !== "config_meta" && t !== "providers",
  )) {
    if (await db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).first())
      throw new TransferError(`Target contains business data: ${table}`);
  }
  const providers = (
    await db.prepare("SELECT * FROM providers ORDER BY position").all()
  ).results;
  const expected = ["antigravity", "codex", "claude", "xai"];
  if (prepared && providers.length === 0) return;
  if (providers.length !== 4)
    throw new TransferError("Target is not a fresh instance");
  for (const [index, row] of providers.entries()) {
    const type = expected[index];
    const defaults = {
      supports_websocket: type === "codex",
      supports_web_search: type === "codex",
      anthropic_1m_context: false,
      emulate_claude_code: false,
      account_selection: "round_robin",
      ...(type === "codex" ? { auto_consume_resets: false } : {}),
      ...(["claude", "xai"].includes(type!)
        ? { allow_extra_usage: false }
        : {}),
      ...(type === "xai" ? { inject_x_search: false } : {}),
    };
    const names = ["Antigravity", "Codex", "Claude", "Xai"];
    if (
      row.type !== type ||
      row.name !== names[index] ||
      row.disabled !== 1 ||
      row.priority !== 100 ||
      row.position !== index ||
      row.version !== 0 ||
      row.deleted_at !== null ||
      row.proxy_group_id !== null ||
      row.created_at !== row.updated_at ||
      typeof row.settings_json !== "string" ||
      (await hash(JSON.parse(row.settings_json))) !== (await hash(defaults))
    )
      throw new TransferError("Target native providers have been modified");
  }
}
