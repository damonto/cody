import { z } from "zod";
import { sqlDialect, type SqlDatabase } from "../../platform/bindings.ts";
import { insertIgnore } from "../../platform/sql-dialect.ts";

/** Deployment-local identity; deliberately excluded from business data transfer. */
export async function siwcHostId(db: SqlDatabase): Promise<string> {
  const read = () =>
    db
      .prepare("SELECT host_id FROM oauth_host_identity WHERE id = 1")
      .first<{ host_id: string }>();
  let row = await read();
  if (!row) {
    await db
      .prepare(
        insertIgnore(
          sqlDialect(db),
          "INSERT INTO oauth_host_identity (id, host_id) VALUES (1, ?)",
        ),
      )
      .bind(crypto.randomUUID())
      .run();
    row = await read();
  }
  return `urn:uuid:${z.uuid().parse(row?.host_id)}`;
}
