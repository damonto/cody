import { z } from "zod";
import { decryptConfig } from "../control/crypto.ts";
import { storedSchema } from "../providers/oauth/state.ts";
import type { SqlDatabase } from "../platform/bindings.ts";
import type { ObjectStorage } from "../platform/object-context.ts";
import {
  TransferError,
  hash,
  type ObjectRef,
  type ObjectSnapshot,
} from "./protocol.ts";

export interface TransferObjects {
  ids?(refs: ObjectRef[]): Promise<string[]>;
  countUnmapped?(refs: ObjectRef[]): Promise<Record<string, number>>;
  read(ref: ObjectRef): Promise<ObjectSnapshot>;
  write(snapshot: ObjectSnapshot, digest: string): Promise<void>;
  schedule(ref: ObjectRef, alarm: number | null): Promise<void>;
  empty(): Promise<boolean>;
}

export async function objectInventory(db: SqlDatabase): Promise<{
  objects: ObjectRef[];
  orphanedOAuth: string[];
}> {
  const providers = (
    await db
      .prepare("SELECT id FROM providers ORDER BY id")
      .all<{ id: string }>()
  ).results;
  const credentials = (
    await db
      .prepare(
        "SELECT account_ref FROM provider_credentials WHERE account_ref IS NOT NULL",
      )
      .all<{ account_ref: string }>()
  ).results;
  const referencedAccounts = new Set(credentials.map((row) => row.account_ref));
  const accounts = (
    await db
      .prepare(
        "SELECT account_ref, provider_id FROM oauth_accounts ORDER BY account_ref",
      )
      .all<{
        account_ref: string;
        provider_id: string;
      }>()
  ).results;
  const providerIds = new Set(providers.map((row) => row.id));
  // Old indexes have no provider FK. Only unowned, unreferenced accounts are
  // candidates for omission; valid disabled/soft-deleted accounts stay intact.
  const orphans = new Set(
    accounts
      .filter(
        (row) =>
          !providerIds.has(row.provider_id) &&
          !referencedAccounts.has(row.account_ref),
      )
      .map((row) => row.account_ref),
  );
  const historySchema = z.object({
    providers: z.array(
      z.object({
        credentials: z.array(
          z.object({
            auth: z.object({
              type: z.string(),
              account_ref: z.string().optional(),
            }),
          }),
        ),
      }),
    ),
  });
  let version = "0";
  while (orphans.size) {
    const history = (
      await db
        .prepare(
          "SELECT CAST(version AS TEXT) AS version, config_json FROM config_snapshots WHERE version > CAST(? AS BIGINT) ORDER BY version LIMIT 50",
        )
        .bind(version)
        .all<{ version: string; config_json: string }>()
    ).results;
    if (!history.length) break;
    for (const row of history) {
      for (const provider of historySchema.parse(JSON.parse(row.config_json))
        .providers) {
        for (const credential of provider.credentials) {
          if (!credential.auth.account_ref) continue;
          orphans.delete(credential.auth.account_ref);
        }
      }
      version = row.version;
    }
  }
  return {
    objects: accounts
      .filter((row) => !orphans.has(row.account_ref))
      .map((row) => ({ kind: "oauth", name: row.account_ref })),
    orphanedOAuth: [...orphans],
  };
}

export async function validateObject(
  db: SqlDatabase,
  key: string,
  snapshot: ObjectSnapshot,
): Promise<void> {
  if (snapshot.ref.kind !== "oauth")
    throw new TransferError("Only OAuth objects are transferred");
  if (!snapshot.entries.length)
    throw new TransferError("OAuth account state is missing");
  const [name, ciphertext] = snapshot.entries[0];
  if (
    snapshot.entries.length !== 1 ||
    name !== "account" ||
    typeof ciphertext !== "string"
  )
    throw new TransferError("Invalid OAuth object");
  const account = storedSchema.parse(await decryptConfig(ciphertext, key));
  const row = await db
    .prepare(
      "SELECT a.provider_id, a.provider_type FROM oauth_accounts a JOIN providers p ON p.id = a.provider_id AND p.type = a.provider_type WHERE a.account_ref = ?",
    )
    .bind(snapshot.ref.name)
    .first<{ provider_id: string; provider_type: string }>();
  if (
    !row ||
    account.account_ref !== snapshot.ref.name ||
    account.provider_id !== row.provider_id ||
    account.provider_type !== row.provider_type
  )
    throw new TransferError("OAuth account identity does not match SQL");
}

export async function readObjectStorage(
  storage: ObjectStorage,
  ref: ObjectRef,
): Promise<ObjectSnapshot> {
  const entries = [...(await storage.list()).entries()];
  return { ref, entries, alarm: await storage.getAlarm() };
}

/** Compare the complete existing state when replaying a lost acknowledgement. */
export async function writeObjectStorage(
  storage: ObjectStorage,
  snapshot: ObjectSnapshot,
  digest: string,
): Promise<void> {
  if ((await hash(snapshot)) !== digest)
    throw new TransferError("Object digest mismatch");
  await storage.transaction(async (tx) => {
    const entries = [...(await tx.list()).entries()];
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const incoming = [...snapshot.entries].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (entries.length) {
      if ((await hash(entries)) !== (await hash(incoming)))
        throw new TransferError("Target object contains different state");
      return;
    }
    for (const [key, value] of snapshot.entries) await tx.put(key, value);
    // The CLI restores scheduling only after all content has been verified.
  });
}
