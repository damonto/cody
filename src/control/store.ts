import { DEFAULT_REPORTING } from "../billing/config.ts";
import { priceVersion } from "../billing/calculate.ts";
import { parseConfig } from "../config/store.ts";
import { record } from "../telemetry/usage.ts";
import { draftConfigurationSchema } from "../shared/forms.ts";
import { SECRET_PLACEHOLDER } from "../shared/secrets.ts";
import { maskedConfigurationSchema } from "../config/schema.ts";
import type { DraftView } from "./schema.ts";
export type { DraftView } from "./schema.ts";
import type { GatewayConfig } from "../config/types.ts";
import { decryptConfig, encryptConfig } from "./crypto.ts";

export { SECRET_PLACEHOLDER } from "../shared/secrets.ts";
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ControlState {
  draft_version: number;
  draft_payload: string | null;
  published_revision: number | null;
  updated_at: number;
}

export class ControlConflict extends Error {
  override name = "ControlConflict";
}
export class ControlInputError extends Error {
  override name = "ControlInputError";
}

function initialConfig(): unknown {
  return {
    services: [],
    api_keys: [],
    model_routes: {},
    web_search: { mode: "proxy" },
    model_policies: [],
    reporting: { ...DEFAULT_REPORTING },
  };
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const item = record(entry);
        return item ? [item] : [];
      })
    : [];
}

/** Preserve secrets by stable service/key/client IDs, never by array position. */
export function restoreSecrets(value: unknown, previous: unknown): unknown {
  const restored: unknown = structuredClone(value);
  const input = record(restored);
  const old = record(previous);
  if (!input) throw new ControlInputError("Configuration must be an object");
  delete input.revision;
  const restore = (
    entry: Record<string, unknown>,
    existing: Record<string, unknown> | undefined,
    field = "api_key",
  ): void => {
    if (entry[field] === SECRET_PLACEHOLDER) {
      if (
        typeof existing?.[field] !== "string" ||
        existing[field] === SECRET_PLACEHOLDER
      )
        throw new ControlInputError("A new credential requires a secret value");
      entry[field] = existing[field];
    }
  };
  const restoreProxy = (
    entry: Record<string, unknown>,
    existing: Record<string, unknown> | undefined,
  ): void => {
    const proxy = record(entry.proxy);
    if (proxy) restore(proxy, record(existing?.proxy), "password");
  };
  for (const service of entries(input.services)) {
    const existing = entries(old?.services).find(
      (item) => item.id === service.id,
    );
    restoreProxy(service, existing);
    for (const credential of entries(service.keys)) {
      const oldCredential = entries(existing?.keys).find(
        (item) => item.id === credential.id,
      );
      restore(credential, oldCredential);
      restoreProxy(credential, oldCredential);
    }
  }
  for (const client of entries(input.api_keys))
    restore(
      client,
      entries(old?.api_keys).find((item) => item.id === client.id),
    );
  const search = record(input.web_search);
  if (search) restore(search, record(old?.web_search));
  return restored;
}

export function maskSecrets(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(maskSecrets);
  const input = record(value);
  if (!input)
    return typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
      ? value
      : null;
  return Object.fromEntries(
    Object.entries(input).map(([name, entry]) => [
      name,
      (name === "api_key" || name === "password") &&
      typeof entry === "string" &&
      entry
        ? SECRET_PLACEHOLDER
        : maskSecrets(entry),
    ]),
  );
}

export class ControlStore {
  constructor(
    readonly db: D1Database,
    private readonly kv: KVNamespace,
    private readonly encryptionKey: string,
    private readonly configKey = "gateway-config",
  ) {}

  async state(): Promise<ControlState> {
    const state = await this.db
      .prepare(
        "SELECT draft_version, draft_payload, published_revision, updated_at FROM control_state WHERE id = 1",
      )
      .first<ControlState>();
    if (!state)
      throw new Error(
        "Control database is not initialized; apply D1 migrations",
      );
    return state;
  }

  async rawDraft(state = this.state()): Promise<unknown> {
    const current = await state;
    return current.draft_payload
      ? decryptConfig(current.draft_payload, this.encryptionKey)
      : initialConfig();
  }

  async view(): Promise<DraftView> {
    const state = await this.state();
    const config = await this.rawDraft(Promise.resolve(state));
    let validationError: string | null = null;
    try {
      parseConfig(config);
    } catch (error) {
      validationError =
        error instanceof Error ? error.message : "Invalid configuration";
    }
    return {
      version: state.draft_version,
      published_revision: state.published_revision,
      config: maskedConfigurationSchema.parse(maskSecrets(config)),
      valid: validationError === null,
      validation_error: validationError,
    };
  }

  async save(
    value: unknown,
    expectedVersion: number,
    actor: string,
  ): Promise<DraftView> {
    const current = await this.state();
    if (expectedVersion !== current.draft_version)
      throw new ControlConflict("The draft changed; reload before saving");
    let restored = restoreSecrets(
      value,
      await this.rawDraft(Promise.resolve(current)),
    );
    try {
      restored = parseConfig(restored);
    } catch {
      restored = draftConfigurationSchema.parse(restored);
    }
    if (new TextEncoder().encode(JSON.stringify(restored)).length > 1024 * 1024)
      throw new ControlInputError("Configuration exceeds 1 MiB");
    const encrypted = await encryptConfig(restored, this.encryptionKey);
    const now = Date.now();
    const [updated] = await this.db.batch([
      this.db
        .prepare(
          "UPDATE control_state SET draft_payload = ?, draft_version = draft_version + 1, updated_at = ? WHERE id = 1 AND draft_version = ?",
        )
        .bind(encrypted, now, expectedVersion),
      this.db
        .prepare(
          "INSERT INTO audit_log (id, created_at, actor, action) SELECT ?, ?, ?, 'save_draft' WHERE changes() = 1",
        )
        .bind(crypto.randomUUID(), now, actor),
    ]);
    if (updated.meta.changes !== 1)
      throw new ControlConflict("The draft changed; reload before saving");
    return this.view();
  }

  async createRevision(
    expectedVersion: number,
    actor: string,
    sourceRevision: number | null = null,
  ): Promise<number> {
    const state = await this.state();
    if (state.draft_version !== expectedVersion)
      throw new ControlConflict("The draft changed; reload before publishing");
    const config = parseConfig(await this.rawDraft(Promise.resolve(state)));
    delete config.revision;
    const payload = await encryptConfig(config, this.encryptionKey);
    const inserted = await this.db
      .prepare(
        "INSERT INTO config_revisions (payload, created_at, actor, source_revision) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .bind(payload, Date.now(), actor, sourceRevision)
      .first<{ id: number }>();
    if (!inserted) throw new Error("Could not create configuration revision");
    return inserted.id;
  }

  async revision(id: number): Promise<GatewayConfig> {
    const row = await this.db
      .prepare("SELECT payload FROM config_revisions WHERE id = ?")
      .bind(id)
      .first<{ payload: string }>();
    if (!row)
      throw new ControlInputError("Configuration revision does not exist");
    return {
      ...parseConfig(await decryptConfig(row.payload, this.encryptionKey)),
      revision: id,
    };
  }

  async publishRevision(id: number): Promise<void> {
    const state = await this.state();
    if (state.published_revision !== null && state.published_revision >= id)
      return;
    const config = await this.revision(id);
    const now = Date.now();
    const policies = (config.model_policies ?? []).map((policy) =>
      this.db
        .prepare(
          "INSERT OR IGNORE INTO pricing_versions (id, revision, service_id, model, policy_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          priceVersion(id, policy.service_id, policy.model),
          id,
          policy.service_id,
          policy.model,
          JSON.stringify(policy),
          now,
        ),
    );
    // The policy ledger exists before a gateway can observe this snapshot.
    for (let i = 0; i < policies.length; i += 50)
      await this.db.batch(policies.slice(i, i + 50));
    await this.kv.put(this.configKey, JSON.stringify(config));
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE control_state SET published_revision = ? WHERE id = 1 AND (published_revision IS NULL OR published_revision < ?)",
        )
        .bind(id, id),
      this.db
        .prepare(
          "UPDATE config_revisions SET status = 'published', published_at = COALESCE(published_at, ?) WHERE id = ?",
        )
        .bind(now, id),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO audit_log (id, created_at, actor, action, revision) SELECT ?, ?, actor, 'publish', id FROM config_revisions WHERE id = ?",
        )
        .bind(`publish:${id}`, now, id),
    ]);
  }
}
