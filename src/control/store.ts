import { priceVersion } from "../billing/calculate.ts";
import { DEFAULT_REPORTING } from "../billing/config.ts";
import { maskedConfigurationSchema } from "../config/schema.ts";
import { parseConfig } from "../config/store.ts";
import type { GatewayConfig } from "../config/types.ts";
import { draftConfigurationSchema } from "../shared/forms.ts";
import { SECRET_PLACEHOLDER } from "../shared/secrets.ts";
import { record } from "../telemetry/usage.ts";
import { decryptConfig, encryptConfig } from "./crypto.ts";
import type { DraftView } from "./schema.ts";
import {
  sqlDialect,
  type KeyValueStore,
  type SqlDatabase,
} from "../platform/bindings.ts";
import { insertIgnore } from "../platform/sql-dialect.ts";
export type { DraftView } from "./schema.ts";

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
    proxy_groups: [],
    providers: [],
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

/** Preserve secrets by stable provider/credential/client IDs, never by array position. */
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
  for (const group of entries(input.proxy_groups)) {
    const existing = entries(old?.proxy_groups).find(
      (item) => item.id === group.id,
    );
    for (const proxy of entries(group.proxies))
      restore(
        proxy,
        entries(existing?.proxies).find((item) => item.id === proxy.id),
        "password",
      );
  }
  for (const provider of entries(input.providers)) {
    const existing = entries(old?.providers).find(
      (item) => item.id === provider.id,
    );
    if (existing && existing.type !== provider.type)
      throw new ControlInputError(
        "A provider's type cannot be changed; create a new provider",
      );
    for (const credential of entries(provider.credentials)) {
      const oldCredential = entries(existing?.credentials).find(
        (item) => item.id === credential.id,
      );
      const auth = record(credential.auth);
      const oldAuth = record(oldCredential?.auth);
      if (auth)
        restore(auth, auth.type === oldAuth?.type ? oldAuth : undefined);
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

const isSecretField = (name: string): boolean =>
  name === "api_key" || name === "password";

/** Stored drafts hold real secrets; a placeholder means a restoration was skipped. */
export function hasSecretPlaceholder(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretPlaceholder);
  const input = record(value);
  return (
    !!input &&
    Object.entries(input).some(([name, entry]) =>
      isSecretField(name)
        ? entry === SECRET_PLACEHOLDER
        : hasSecretPlaceholder(entry),
    )
  );
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
      isSecretField(name) && typeof entry === "string" && entry
        ? SECRET_PLACEHOLDER
        : maskSecrets(entry),
    ]),
  );
}

export class ControlStore {
  constructor(
    readonly db: SqlDatabase,
    private readonly kv: KeyValueStore,
    private readonly encryptionKey: string,
    private readonly configKey = "gateway-config",
  ) {}

  private async validateOAuthReferences(config: GatewayConfig): Promise<void> {
    for (const provider of config.providers) {
      if (provider.type !== "antigravity") continue;
      for (const credential of provider.credentials) {
        const row = await this.db
          .prepare(
            "SELECT provider_id FROM oauth_accounts WHERE account_ref = ?",
          )
          .bind(credential.auth.account_ref)
          .first<{ provider_id: string }>();
        if (!row || row.provider_id !== provider.id)
          throw new ControlInputError(
            "OAuth account must be authorized for this provider before saving",
          );
      }
    }
  }

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
    await this.validateOAuthReferences(
      draftConfigurationSchema.parse(restored),
    );
    const encrypted = await encryptConfig(restored, this.encryptionKey);
    const now = Date.now();
    const [updated] =
      sqlDialect(this.db) === "postgres"
        ? await this.db.batch([
            // The audit row is inserted only when the guarded update changed the draft.
            this.db
              .prepare(
                "WITH updated AS (UPDATE control_state SET draft_payload = ?, draft_version = draft_version + 1, updated_at = ? WHERE id = 1 AND draft_version = ? RETURNING id) INSERT INTO audit_log (id, created_at, actor, action) SELECT ?, ?, ?, 'save_draft' FROM updated",
              )
              .bind(
                encrypted,
                now,
                expectedVersion,
                crypto.randomUUID(),
                now,
                actor,
              ),
          ])
        : await this.db.batch([
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
    await this.validateOAuthReferences(config);
    delete config.revision;
    const payload = await encryptConfig(config, this.encryptionKey);
    const inserted = await this.db
      .prepare(
        "INSERT INTO config_revisions (payload, created_at, actor, source_revision) SELECT ?, ?, ?, ? FROM control_state WHERE id = 1 AND draft_version = ? RETURNING id",
      )
      .bind(payload, Date.now(), actor, sourceRevision, expectedVersion)
      .first<{ id: number }>();
    if (!inserted)
      throw new ControlConflict("The draft changed; reload before publishing");
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
          insertIgnore(
            sqlDialect(this.db),
            "INSERT INTO pricing_versions (id, revision, provider_id, model, policy_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          ),
        )
        .bind(
          priceVersion(id, policy.provider_id, policy.model),
          id,
          policy.provider_id,
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
          insertIgnore(
            sqlDialect(this.db),
            "INSERT INTO audit_log (id, created_at, actor, action, revision) SELECT ?, ?, actor, 'publish', id FROM config_revisions WHERE id = ?",
          ),
        )
        .bind(`publish:${id}`, now, id),
    ]);
  }
}
