import type { SqlDatabase } from "../platform/bindings.ts";
import type { EntityRows } from "./entities.ts";
import { SecretRepository } from "./secret-repository.ts";

/** A transaction plan for SQL batch runtimes, including D1; no writes occur before commit. */
export class ConfigurationUnitOfWork {
  readonly secrets: SecretRepository;
  constructor(
    readonly rows: EntityRows,
    readonly version: number,
    readonly now: number,
    db: SqlDatabase,
    key: string,
  ) {
    this.secrets = new SecretRepository(db, key, now);
  }
  metadata(previous?: { id: string; created_at: number }) {
    return {
      id: previous?.id ?? crypto.randomUUID(),
      created_at: previous?.created_at ?? this.now,
      updated_at: this.now,
      version: this.version,
      deleted_at: null,
    };
  }
}

export interface ConfigurationOperation {
  version: number;
  operation_id: string;
  actor: string;
  request: unknown;
}
