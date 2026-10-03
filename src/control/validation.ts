import { z } from "zod";
import type { SqlDatabase } from "../platform/bindings.ts";
import type { GatewayConfig } from "../config/types.ts";
import type { EntityRows } from "./entities.ts";
import type { ConfigurationUnitOfWork } from "./unit-of-work.ts";
import { ControlInputError } from "./errors.ts";

export async function validateOAuth(
  db: SqlDatabase,
  config: GatewayConfig,
): Promise<void> {
  const expected = config.providers.flatMap((provider) =>
    provider.credentials.flatMap((credential) =>
      credential.auth.type === "oauth"
        ? [
            {
              account_ref: credential.auth.account_ref,
              provider_id: provider.id,
              provider_type: provider.type,
            },
          ]
        : [],
    ),
  );
  const accountSchema = z.object({
    account_ref: z.string(),
    provider_id: z.string(),
    provider_type: z.string(),
  });
  for (let i = 0; i < expected.length; i += 50) {
    const batch = expected.slice(i, i + 50);
    const result = await db
      .prepare(
        `SELECT account_ref, provider_id, provider_type FROM oauth_accounts WHERE account_ref IN (${batch.map(() => "?").join(",")})`,
      )
      .bind(...batch.map((account) => account.account_ref))
      .all();
    const accounts = new Map(
      z
        .array(accountSchema)
        .parse(result.results)
        .map((account) => [account.account_ref, account]),
    );
    for (const account of batch) {
      const row = accounts.get(account.account_ref);
      if (
        row?.provider_id !== account.provider_id ||
        row.provider_type !== account.provider_type
      )
        throw new ControlInputError(
          "OAuth account must belong to this provider",
        );
    }
  }
}

export async function validateClientKeys(
  work: ConfigurationUnitOfWork,
  previous: EntityRows,
): Promise<void> {
  const active = work.rows.clients.filter((row) => row.deleted_at === null);
  const previousKeys = new Map(
    previous.clients
      .filter((row) => row.deleted_at === null)
      .map((row) => [row.id, row.secret_id]),
  );
  if (active.every((row) => previousKeys.get(row.id) === row.secret_id)) return;
  // Different secret-version UUIDs can still contain the same plaintext key.
  const keys = new Set<string>();
  for (const row of active) {
    const key = await work.secrets.read(row.secret_id);
    if (keys.has(key))
      throw new ControlInputError("Client API keys must be unique");
    keys.add(key);
  }
}
