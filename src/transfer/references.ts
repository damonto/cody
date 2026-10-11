import { z } from "zod";
import { secretId } from "../control/secrets.ts";
import type { SqlDatabase } from "../platform/bindings.ts";
import { TransferError, type TransferRow } from "./protocol.ts";

const snapshotSchema = z.object({
  providers: z.array(
    z.object({
      credentials: z.array(
        z.object({
          auth: z.discriminatedUnion("type", [
            z.object({ type: z.literal("api_key") }),
            z.object({ type: z.literal("oauth"), account_ref: z.uuid() }),
          ]),
        }),
      ),
    }),
  ),
  model_prices: z.array(z.object({ version_id: z.uuid() })).optional(),
});

/** JSON references have no SQL foreign keys. Check each page in bounded batches. */
export async function validateSnapshotReferences(
  db: SqlDatabase,
  rows: TransferRow[],
): Promise<void> {
  const secrets = new Set<string>();
  const accounts = new Set<string>();
  const prices = new Set<string>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [name, entry] of Object.entries(value)) {
        const id =
          name === "api_key" || name === "password"
            ? secretId(entry)
            : undefined;
        if (id) secrets.add(id);
        else visit(entry);
      }
    }
  }
  for (const row of rows) {
    const value: unknown = JSON.parse(z.string().parse(row.config_json));
    const snapshot = snapshotSchema.parse(value);
    visit(value);
    for (const provider of snapshot.providers)
      for (const credential of provider.credentials)
        if (credential.auth.type === "oauth")
          accounts.add(credential.auth.account_ref);
    for (const price of snapshot.model_prices ?? [])
      prices.add(price.version_id);
  }
  for (const [table, key, references] of [
    ["secret_versions", "id", secrets],
    ["oauth_accounts", "account_ref", accounts],
    ["model_price_versions", "id", prices],
  ] as const) {
    const ids = [...references];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const { results } = await db
        .prepare(
          `SELECT ${key} FROM ${table} WHERE ${key} IN (${batch.map(() => "?").join(",")})`,
        )
        .bind(...batch)
        .all();
      if (results.length !== batch.length)
        throw new TransferError(
          `Configuration snapshot references missing ${table} records`,
        );
    }
  }
}
