import type { SqlDatabase } from "../../src/platform/bindings.ts";
import type { GatewayConfig } from "../../src/config/types.ts";

/** Install a routing fixture directly; entity persistence has separate SQL tests. */
export async function setTestConfiguration(
  db: SqlDatabase,
  _key: string,
  raw: string,
): Promise<void> {
  const config: GatewayConfig = JSON.parse(raw);
  for (const price of config.model_prices ?? [])
    price.version_id ??= crypto.randomUUID();
  const state = await db
    .prepare("SELECT version FROM config_meta WHERE id=1")
    .first<{ version: number }>();
  const version = (state?.version ?? 0) + 1;
  await db.batch([
    db
      .prepare(
        "INSERT INTO config_snapshots(version,config_json,actor,created_at) VALUES (?,?,'routing-test',0)",
      )
      .bind(version, JSON.stringify(config)),
    db
      .prepare("UPDATE config_meta SET version=?,maintenance=0 WHERE id=1")
      .bind(version),
  ]);
}
