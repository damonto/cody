# Configuration and resource APIs

Read this guide for configuration schemas, SQL entities, resource services, pricing or migrations. For runtime database behavior, also read [Platforms and persistence](platforms.md).

## Ownership and write path

Start with `src/config/schema.ts`, `src/control/resource-input.ts`, `src/admin/resource-schema.ts`, `src/control/services/`, `src/control/store.ts`, `src/control/unit-of-work.ts` and `src/control/compiler.ts`.

- SQL entities are authoritative on every platform. Keep HTTP routes thin: resource services edit typed entities through the configuration unit of work; only the one-way compiler builds runtime configuration.
- Save entities, encrypted secret versions, immutable compiled snapshots, configuration version, price history and audit in one fenced transaction. Writes require the current version and an idempotent operation ID.
- Runtime checks SQL version on every request and WebSocket turn. SQL failures fail closed.
- Generate UUID identities on the server and preserve them across renames. Soft-delete entities and relations; retain historical references without exposing archive browsing or per-entity restoration.
- Management reads query their resource tables without decrypting unrelated secrets. Query projections may access only selected tables. Document projection is reserved for historical recovery and test seeding.
- Configuration restoration keeps current secrets and never restores OAuth token/session state. No persisted drafts, manual publish, publisher object, KV config distribution, whole-config mutation or import/export endpoint.
- Keep resource API schemas, runtime schema, compiler and tests consistent. Validate at API and snapshot boundaries; there is no generated JSON Schema or file-based configuration workflow.

## Current configuration shape

- Use `providers` directly, without a schema-version field. Only `ai_gateway`, `antigravity`, `codex`, `claude` and `xai` are implemented. Do not accept another native type before its adapter and credential resolver exist.
- AI Gateway permits multiple providers. Native providers are optional singletons by type, with editable names and server-generated IDs. `0015_native_provider_defaults.sql` seeds missing native providers disabled without replacing existing providers or immutable snapshots; the console does not create/delete native providers.
- Deleting an AI Gateway provider atomically soft-deletes its credentials, models, prices and owned routes, and detaches client/route relations. Retain clients with an empty provider list (no upstream access). Soft-delete global/client routes that lose all explicitly allowed providers or whose target is no longer supported; never turn an empty restriction into unrestricted access. Preserve historical identities, snapshots and price versions.
- `providers[].models` contains real upstream model names. AI Gateway always requires non-empty models and credentials. Enabled native providers require both; disabled native providers may save empty arrays so settings and OAuth setup can happen independently. Unsaved forms may be incomplete.
- Every credential has an ID and explicit `priority` and `disabled`. AI Gateway uses `auth: { type: "api_key", api_key: string }`; native providers use `auth: { type: "oauth", account_ref: UUID }`. An OAuth reference must belong to its provider. Reject flat `api_key` fields and mismatched authentication types.
- Native providers use their implemented official endpoints and reject `base_url`. Codex also rejects enabling `anthropic_1m_context` or `emulate_claude_code`; do not broaden native capabilities by inheriting AI Gateway settings.
- Providers do not declare a protocol. Reject `providers[].protocol`; derive the dialect per request in `src/gateway/protocol.ts`.
- SOCKS5 nodes live in top-level `proxy_groups` with `random`, `sticky` or `priority` strategy. Provider and credential `proxy_group` fields reference groups; omitted credential fields inherit, while `null` selects direct access. Reject inline `proxy` fields.
- Provider model settings own `context_window`. Prices live in `model_prices` and `model_price_versions`; versions have generated UUIDs, a `model_price_id` foreign key and unique `(revision, model_price_id)`. Compiled snapshots carry `version_id`; metering never reconstructs identities from names. Antigravity family price/context APIs resolve members from authoritative entities and update them in one fenced transaction, preserving each physical model and price UUID. Newly enabled levels inherit consistent family rates/context; conflicting sibling settings require a shared edit first.
- Global reporting and web-search settings live in `settings`, keyed by name, with encrypted credentials referenced by `secret_id`.

## Routes and retry validation

- Optional global `model_routes` map client-facing names to upstream models supported by at least one provider. When a route specifies `providers`, each must exist and list the upstream model; routing intersects that list with the authenticated client's allowed providers.
- Optional provider-level `model_routes` target real models or supported Antigravity Gemini families in that provider's `models` and must not include a `providers` field. Client API keys may reference only declared providers through `api_keys[].providers`.
- Resolve routes for each candidate provider: provider route > client API key route > global route. The selected provider's route determines the rewritten upstream model.
- Antigravity Gemini family route targets are derived from configured physical low/medium/high variants. Apply the same support predicate to global, client and provider routes and provider restrictions. Reject removal of the final variant while a family route still references it; do not persist derived family IDs as physical models.
- Optional provider `retry` enables retries only when explicitly configured. At least one of `status_codes` or `error_codes` must be non-empty exactly when `delays_ms` is non-empty; delays define the shared retry count. Runtime limits are in [Gateway](gateway.md).

## Migration baseline

Inspect the matching files in `migrations/d1/` and `migrations/postgres/`, plus `tests/configuration-cleanup.test.mjs`, `tests/entity-configuration.test.mjs` and `tests/native-provider-defaults.test.mjs` before editing the schema.

- Keep `0001_control_and_usage.sql` stable: deployed databases record that filename as applied. Preserve OAuth migrations `0007` through `0010` and all subsequent applied records.
- `0012_entity_configuration.sql` initializes the final entity schema, including `settings` and UUID price versions, and removes old document stores without creating conversion tables.
- The Provider conversion, entity cutover, manual `0013` cleanup and one-time `0014` price migration are retired. Do not recreate their files, parsers, converters or runtime compatibility upgrades.
- Existing databases retain their migration history. Never rerun `0012` to repair an older schema. If a database still has the old `configuration_settings` name, reconcile that schema explicitly before running the updated application; do not add an automatic runtime rename or conversion.
- New schema changes go in new migrations. Match D1/PostgreSQL behavior and retain atomicity; SQLite/libSQL reuse D1 migrations plus `migrations/sqlite/`.
