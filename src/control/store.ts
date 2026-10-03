import { ControlConflict, ControlInputError } from "./errors.ts";
import {
  maskSecrets,
  restoreSecrets,
  resolveSecrets,
  sealConfiguration,
} from "./secrets.ts";
import { commitConfiguration } from "./transaction.ts";
import { maskedConfigurationSchema } from "../config/schema.ts";
import { parseConfig } from "../config/parse.ts";
import type { GatewayConfig } from "../config/types.ts";
import { decryptConfig } from "./crypto.ts";
import { revisionSchema, type ConfigurationView } from "./schema.ts";
import { type SqlDatabase } from "../platform/bindings.ts";
import { z } from "zod";
import { assignIdentities, projectConfiguration } from "./projection.ts";
import { entityTables, type EntityRows, type EntityTable } from "./entities.ts";
import { configurationFromEntities, compileSnapshot } from "./compiler.ts";
import { ConfigurationUnitOfWork } from "./unit-of-work.ts";
import { SecretRepository } from "./secret-repository.ts";
import { configurationError } from "../config/schema.ts";
import { readEntities } from "./repository.ts";
import { validateOAuth, validateClientKeys } from "./validation.ts";
import { preserveCurrentSecrets } from "./recovery.ts";
import type { ConfigurationOperation } from "./unit-of-work.ts";
export type { ConfigurationView } from "./schema.ts";

export { SECRET_PLACEHOLDER } from "../shared/secrets.ts";
export interface ControlState {
  version: number;
  maintenance: number;
  updated_at: number;
}

const stateSchema = z.object({
  version: z.number().int().nonnegative(),
  maintenance: z.number(),
  updated_at: z.number(),
});
const operationSchema = z.object({
  version: z.number(),
  input_hash: z.string(),
  actor: z.string(),
});
const snapshotSchema = z.object({
  version: z.number(),
  config_json: z.string(),
});
const snapshotPriceReferences = z.object({
  model_prices: z.array(z.object({ version_id: z.uuid() })).optional(),
});
async function digest(value: unknown): Promise<string> {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class ControlStore {
  constructor(
    readonly db: SqlDatabase,
    private readonly encryptionKey: string,
  ) {}

  async state(): Promise<ControlState> {
    const state = await this.db
      .prepare(
        "SELECT version, maintenance, updated_at FROM config_meta WHERE id = 1",
      )
      .first();
    if (!state)
      throw new Error(
        "Configuration database is not initialized; apply migrations",
      );
    return stateSchema.parse(state);
  }

  private async entities<K extends EntityTable>(
    tables: readonly K[],
    includeDeleted = true,
  ): Promise<{ state: ControlState; rows: Pick<EntityRows, K> }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.state();
      const rows = await readEntities(this.db, tables, { includeDeleted });
      const after = await this.state();
      if (before.version === after.version) return { state: after, rows };
    }
    throw new ControlConflict(
      "Configuration changed while reading; reload and retry",
    );
  }

  async current(): Promise<GatewayConfig> {
    const state = await this.state();
    if (state.maintenance)
      throw new ControlConflict("Configuration is in maintenance mode");
    if (state.version) return this.revision(state.version);
    return configurationFromEntities((await this.entities(entityTables)).rows);
  }

  /** Management and inference share the exact committed snapshot. */
  async committed(): Promise<GatewayConfig> {
    const state = await this.state();
    if (state.maintenance)
      throw new ControlConflict("Configuration is in maintenance mode");
    return state.version ? this.revision(state.version) : this.current();
  }

  async view(): Promise<ConfigurationView> {
    const state = await this.state();
    if (state.maintenance)
      throw new ControlConflict("Configuration is in maintenance mode");
    return {
      version: state.version,
      config: state.version
        ? await this.maskedRevision(state.version)
        : maskedConfigurationSchema.parse(maskSecrets(await this.current())),
    };
  }

  async resource<K extends EntityTable, T>(
    tables: readonly K[],
    select: (rows: Pick<EntityRows, NoInfer<K>>) => T,
    redact: (item: T) => T = (item) => item,
  ): Promise<{ version: number; item: T; etag: string }> {
    const { state, rows } = await this.entities(tables, false);
    if (state.maintenance)
      throw new ControlConflict("Configuration is in maintenance mode");
    const item = select(rows);
    return {
      version: state.version,
      etag: await digest(item),
      item: redact(item),
    };
  }

  async reveal<K extends EntityTable, T>(
    tables: readonly K[],
    expectedVersion: number,
    select: (
      rows: Pick<EntityRows, NoInfer<K>>,
      secrets: SecretRepository,
    ) => Promise<T>,
  ): Promise<T> {
    const { state, rows } = await this.entities(tables, false);
    if (state.maintenance || state.version !== expectedVersion)
      throw new ControlConflict(
        "Configuration changed; reload before trying again",
      );
    return select(
      rows,
      new SecretRepository(this.db, this.encryptionKey, state.updated_at),
    );
  }

  private async snapshot(version: number) {
    const value = await this.db
      .prepare(
        "SELECT version, config_json FROM config_snapshots WHERE version = ?",
      )
      .bind(version)
      .first();
    if (!value)
      throw new ControlInputError("Configuration version does not exist");
    const snapshot = snapshotSchema.parse(value);
    snapshotPriceReferences.parse(JSON.parse(snapshot.config_json));
    return snapshot;
  }

  private async maskedRevision(version: number): Promise<GatewayConfig> {
    const row = await this.snapshot(version);
    return maskedConfigurationSchema.parse(
      maskSecrets(JSON.parse(row.config_json)),
    );
  }

  async revision(version: number): Promise<GatewayConfig> {
    const row = await this.snapshot(version);
    return {
      ...parseConfig(
        await resolveSecrets(JSON.parse(row.config_json), this.db, (text) =>
          decryptConfig(text, this.encryptionKey),
        ),
      ),
      revision: row.version,
    };
  }

  async replay(
    value: unknown,
    expectedVersion: number,
    actor: string,
    operationId: string | undefined,
    sourceVersion?: number,
  ): Promise<ConfigurationView | null> {
    if (!operationId) return null;
    const prior = await this.db
      .prepare(
        "SELECT version,input_hash,actor FROM config_operations WHERE id=?",
      )
      .bind(operationId)
      .first();
    if (!prior) return null;
    const operation = operationSchema.parse(prior);
    if (
      operation.actor !== actor ||
      operation.input_hash !==
        (await digest({ value, expectedVersion, sourceVersion }))
    )
      throw new ControlConflict(
        "Operation ID was already used for another change",
      );
    return {
      version: operation.version,
      config: await this.maskedRevision(operation.version),
    };
  }

  /** Ordinary CRUD commits entities; recovery shares this exact transaction path. */
  async mutate<T>(
    operation: ConfigurationOperation,
    change: (work: ConfigurationUnitOfWork) => void | Promise<void>,
    select: (config: GatewayConfig) => T,
  ): Promise<{ version: number; item: T }> {
    const committed = await this.write(operation, change);
    return { version: committed.version, item: select(committed.config) };
  }

  private async write(
    operation: ConfigurationOperation,
    change: (work: ConfigurationUnitOfWork) => void | Promise<void>,
    options: { sourceVersion?: number } = {},
  ): Promise<ConfigurationView> {
    const {
      version: expectedVersion,
      operation_id: operationId,
      actor,
      request,
    } = operation;
    z.uuid().parse(operationId);
    const replay = await this.replay(
      request,
      expectedVersion,
      actor,
      operationId,
      options.sourceVersion,
    );
    if (replay) return replay;
    const { state, rows } = await this.entities(entityTables);
    if (state.version !== expectedVersion)
      throw new ControlConflict("Configuration changed; reload before saving");
    if (state.maintenance)
      throw new ControlConflict("Configuration is in maintenance mode");
    const version = state.version + 1;
    const now = Math.max(Date.now(), state.updated_at + 1);
    const work = new ConfigurationUnitOfWork(
      structuredClone(rows),
      version,
      now,
      this.db,
      this.encryptionKey,
    );
    let snapshot: GatewayConfig;
    try {
      await change(work);
      snapshot = compileSnapshot(work.rows, version);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new ControlInputError(configurationError(error));
      throw error;
    }
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 1024 * 1024)
      throw new ControlInputError("Configuration exceeds 1 MiB");
    await validateClientKeys(work, rows);
    await validateOAuth(this.db, snapshot);
    const inputHash = await digest({
      value: request,
      expectedVersion,
      sourceVersion: options.sourceVersion,
    });
    await commitConfiguration(this.db, {
      previous: rows,
      projected: work.rows,
      snapshot,
      secrets: work.secrets.pending,
      version,
      expectedVersion,
      maintenance: state.maintenance,
      now,
      actor,
      operationId,
      inputHash,
      sourceVersion: options.sourceVersion,
    });
    const committed = await this.replay(
      request,
      expectedVersion,
      actor,
      operationId,
      options.sourceVersion,
    );
    if (!committed || committed.version !== version)
      throw new ControlConflict("Configuration changed; reload before saving");
    return committed;
  }

  /** Document replacement is reserved for historical recovery and test seeding. */
  async save(
    value: unknown,
    expectedVersion: number,
    actor: string,
    operationId = crypto.randomUUID(),
    options: {
      sourceVersion?: number;
      requestValue?: unknown;
    } = {},
  ): Promise<ConfigurationView> {
    return this.write(
      {
        version: expectedVersion,
        operation_id: operationId,
        actor,
        request: options.requestValue ?? value,
      },
      async (work) => {
        const previousRefs = configurationFromEntities(work.rows);
        const previous = parseConfig(
          await resolveSecrets(previousRefs, this.db, (text) =>
            decryptConfig(text, this.encryptionKey),
          ),
        );
        let input: unknown;
        try {
          input = assignIdentities(restoreSecrets(value, previous), work.rows);
        } catch (error) {
          throw new ControlInputError(
            error instanceof Error
              ? error.message
              : "Invalid entity identities",
          );
        }
        const config = parseConfig(input);
        if (
          new TextEncoder().encode(JSON.stringify(config)).length >
          1024 * 1024
        )
          throw new ControlInputError("Configuration exceeds 1 MiB");
        const { sealed, secrets } = await sealConfiguration(
          config,
          previous,
          previousRefs,
          this.encryptionKey,
          work.now,
        );
        Object.assign(
          work.rows,
          projectConfiguration(sealed, work.rows, work.version, work.now),
        );
        work.secrets.pending.push(...secrets);
      },
      options,
    );
  }

  async restore(
    version: number,
    expectedVersion: number,
    actor: string,
    operationId?: string,
  ): Promise<ConfigurationView> {
    const requestValue = { restore_version: version };
    const replay = await this.replay(
      requestValue,
      expectedVersion,
      actor,
      operationId,
      version,
    );
    if (replay) return replay;
    const config = parseConfig(
      JSON.parse((await this.snapshot(version)).config_json),
    );
    const current = await this.current();
    preserveCurrentSecrets(config, current);
    return this.save(config, expectedVersion, actor, operationId, {
      sourceVersion: version,
      requestValue,
    });
  }

  async versions() {
    const result = await this.db
      .prepare(
        "SELECT version AS id, created_at, actor, source_version AS source_revision FROM config_snapshots ORDER BY version DESC LIMIT 100",
      )
      .all();
    return z.array(revisionSchema).parse(result.results);
  }

  async names(): Promise<Record<string, string>> {
    const result = await this.db.batch(
      [
        "providers",
        "clients",
        "provider_credentials",
        "proxy_groups",
        "proxy_nodes",
      ].map((table) => this.db.prepare(`SELECT id,name FROM ${table}`)),
    );
    return Object.fromEntries(
      result.flatMap((result) =>
        z
          .array(z.object({ id: z.string(), name: z.string() }))
          .parse(result.results)
          .map((row) => [row.id, row.name]),
      ),
    );
  }
}
