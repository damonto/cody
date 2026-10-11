import { z } from "zod";
import { sqlDialect, type Bindings } from "../platform/bindings.ts";
import { decryptConfig } from "../control/crypto.ts";
import { validateSnapshotReferences } from "./references.ts";
import {
  objectInventory,
  validateObject,
  type TransferObjects,
} from "./objects.ts";
import {
  tableLayout,
  readPage,
  requireEmptyTarget,
  validateRows,
  type TableLayout,
} from "./tables.ts";
import {
  TABLE_KEYS,
  TRANSFER_VERSION,
  TransferError,
  transferFailure,
  canonical,
  hash,
  keyProof,
  parseTransferResult,
  type TransferAction,
  type TransferResult,
  type TransferCommand,
  type ObjectRef,
} from "./protocol.ts";

/** Fixed transfer operations; the CLI owns all job/progress state on local disk.
 * The operator must quiesce both deployments before calling mutating operations.
 */
export class TransferService {
  private layoutValue: Promise<TableLayout> | undefined;
  constructor(
    private readonly env: Pick<Bindings, "CODY_DB" | "CONFIG_ENCRYPTION_KEY">,
    private readonly objects: TransferObjects,
    private readonly platform: "cloudflare" | "standard",
  ) {}
  private get db() {
    return this.env.CODY_DB;
  }
  private layout() {
    return (this.layoutValue ??= tableLayout(this.db));
  }
  private async snapshot(ref: ObjectRef) {
    const value = await this.objects.read(ref);
    await validateObject(this.db, this.env.CONFIG_ENCRYPTION_KEY, value);
    value.entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return value;
  }
  async execute<A extends TransferAction>(
    command: TransferCommand & { action: A },
  ): Promise<TransferResult<A>> {
    try {
      return parseTransferResult(command.action, await this.dispatch(command));
    } catch (error) {
      const context =
        "table" in command
          ? `${command.action} ${command.table}`
          : command.action;
      throw transferFailure(error, context);
    }
  }
  private async dispatch(command: TransferCommand): Promise<TransferResult> {
    switch (command.action) {
      case "preflight": {
        return this.preflight(command.challenge);
      }
      case "prepare": {
        // A zero-provider target is the same empty state after a lost acknowledgement.
        await requireEmptyTarget(this.db, true);
        if (!(await this.objects.empty()))
          throw new TransferError("Target contains persistent objects");
        await this.db.prepare("DELETE FROM providers").run();
        return { ok: true };
      }
      case "inventory": {
        const { objects, orphanedOAuth } = await objectInventory(this.db);
        return {
          objects,
          skipped: (await this.objects.countUnmapped?.(objects)) ?? {},
          orphaned_oauth: orphanedOAuth,
        };
      }
      case "validate": {
        if (
          sqlDialect(this.db) !== "postgres" &&
          (await this.db.prepare("PRAGMA foreign_key_check").first())
        )
          throw new TransferError("Foreign key references are invalid");
        if (
          await this.db
            .prepare(
              "SELECT 1 AS invalid FROM provider_credentials c LEFT JOIN oauth_accounts a ON a.account_ref = c.account_ref WHERE c.auth_type = 'oauth' AND (a.account_ref IS NULL OR a.provider_id <> c.provider_id) LIMIT 1",
            )
            .first()
        )
          throw new TransferError(
            "OAuth credential ownership does not match its account",
          );
        if (
          await this.db
            .prepare(
              "SELECT 1 AS invalid FROM config_meta m LEFT JOIN config_snapshots s ON s.version = m.version WHERE m.version <> 0 AND s.version IS NULL",
            )
            .first()
        )
          throw new TransferError("Current configuration snapshot is missing");
        return { ok: true };
      }
      case "read": {
        const page = await readPage(
          this.db,
          await this.layout(),
          command.table,
          command.cursor,
          command.limit,
        );
        if (command.table === "secret_versions")
          for (const row of page.rows)
            z.string().parse(
              await decryptConfig(
                z.string().parse(row.ciphertext),
                this.env.CONFIG_ENCRYPTION_KEY,
              ),
            );
        if (command.table === "config_snapshots")
          await validateSnapshotReferences(this.db, page.rows);
        return page;
      }
      case "write":
        return this.write(command);
      case "object_ids":
        if (!this.objects.ids)
          throw new TransferError("Object IDs exist only on Cloudflare");
        return { ids: await this.objects.ids(command.refs) };
      case "read_object": {
        const snapshot = await this.snapshot(command.ref);
        return { snapshot, digest: await hash(snapshot) };
      }
      case "write_object":
        await validateObject(
          this.db,
          this.env.CONFIG_ENCRYPTION_KEY,
          command.snapshot,
        );
        if ((await hash(command.snapshot)) !== command.digest)
          throw new TransferError("Object digest mismatch");
        await this.objects.write(command.snapshot, command.digest);
        return { ok: true };
      case "schedule":
        await this.objects.schedule(command.ref, command.alarm);
        return { ok: true };
    }
  }
  private async preflight(
    challenge: string,
  ): Promise<TransferResult<"preflight">> {
    let step = "database schema";
    try {
      this.layoutValue = tableLayout(this.db);
      const layout = await this.layout();
      let empty = true;
      step = "database emptiness";
      try {
        await requireEmptyTarget(this.db);
      } catch (error) {
        if (!(error instanceof TransferError)) throw error;
        empty = false;
      }
      if (empty) {
        step = "persistent object storage";
        empty = await this.objects.empty();
      }
      step = "provider identities";
      const providers = (
        await this.db.prepare("SELECT id FROM providers ORDER BY id").all()
      ).results;
      step = "schema and identity digests";
      const schema = await hash({ version: TRANSFER_VERSION, layout });
      const fingerprint = await hash(providers);
      step = "CONFIG_ENCRYPTION_KEY proof";
      return {
        version: TRANSFER_VERSION,
        platform: this.platform,
        schema,
        fingerprint,
        key_proof: await keyProof(this.env.CONFIG_ENCRYPTION_KEY, challenge),
        empty,
      };
    } catch (error) {
      throw transferFailure(error, step);
    }
  }
  private async write(
    command: Extract<TransferCommand, { action: "write" }>,
  ): Promise<TransferResult<"write">> {
    const { table, cursor, rows, next_cursor } = command;
    if ((await hash({ table, cursor, rows, next_cursor })) !== command.digest)
      throw new TransferError("Page digest mismatch");
    const layout = await this.layout();
    validateRows(layout, table, rows);
    const columns = layout[table],
      names = columns.map((column) => column.name);
    const statements = [];
    const replace = table === "usage_hourly" && cursor === null;
    if (replace) statements.push(this.db.prepare("DELETE FROM usage_hourly"));
    const keys = TABLE_KEYS[table];
    const rowKey = (row: (typeof rows)[number]) =>
      canonical(keys.map((key) => row[key]));
    const existing = new Map<string, (typeof rows)[number]>();
    if (!replace && table !== "config_meta" && rows.length) {
      const saved = await readPage(this.db, layout, table, cursor, rows.length);
      for (const row of saved.rows) existing.set(rowKey(row), row);
    }
    const incomingKeys = new Set(rows.map(rowKey));
    if ([...existing.keys()].some((key) => !incomingKeys.has(key)))
      throw new TransferError(
        `Conflicting row in ${table}; target or source changed`,
      );
    const pending = rows.filter((row) => {
      const saved = existing.get(rowKey(row));
      if (saved && canonical(saved) !== canonical(row))
        throw new TransferError(
          `Conflicting row in ${table}; target or source changed`,
        );
      return !saved;
    });
    if (table === "config_meta") {
      for (const row of pending)
        statements.push(
          this.db
            .prepare(
              `UPDATE config_meta SET ${names
                .filter((n) => n !== "id")
                .map((n) => `${n} = ?`)
                .join(", ")} WHERE id = 1`,
            )
            .bind(...names.filter((n) => n !== "id").map((n) => row[n])),
        );
    } else {
      // Bound parameter counts; each statement inserts many rows, not one row.
      const batchSize = Math.max(
        1,
        Math.floor(
          (this.platform === "cloudflare" ? 100 : 10000) / names.length,
        ),
      );
      const tuple = `(${names.map(() => "?").join(", ")})`;
      for (let offset = 0; offset < pending.length; offset += batchSize) {
        const batch = pending.slice(offset, offset + batchSize);
        statements.push(
          this.db
            .prepare(
              `INSERT INTO ${table} (${names.join(", ")}) VALUES ${batch.map(() => tuple).join(", ")}`,
            )
            .bind(...batch.flatMap((row) => names.map((name) => row[name]))),
        );
      }
    }
    // After a crash, existing rows are read and compared before replay. No remote
    // progress table is needed to recover a committed batch whose ACK was lost.
    if (statements.length) await this.db.batch(statements);
    return { ok: true };
  }
}
