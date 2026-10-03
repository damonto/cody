-- Initialize the current entity schema after the completed configuration cutover.
-- Earlier migrations remain unchanged; obsolete stores are retired below.
CREATE TABLE config_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0,
  operation_id TEXT,
  maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO config_meta (id) VALUES (1);
CREATE TABLE config_operations (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE secret_versions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  field TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE proxy_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  position INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ai_gateway','antigravity','codex','claude','xai')),
  priority INTEGER NOT NULL,
  disabled INTEGER NOT NULL CHECK (disabled IN (0,1)),
  position INTEGER NOT NULL,
  proxy_group_id TEXT REFERENCES proxy_groups(id),
  settings_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX providers_native_singleton ON providers(type)
  WHERE type <> 'ai_gateway' AND deleted_at IS NULL;
CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  name TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('api_key','oauth')),
  secret_id TEXT REFERENCES secret_versions(id),
  account_ref TEXT REFERENCES oauth_accounts(account_ref),
  priority INTEGER NOT NULL,
  disabled INTEGER NOT NULL CHECK (disabled IN (0,1)),
  position INTEGER NOT NULL,
  proxy_mode TEXT NOT NULL CHECK (proxy_mode IN ('inherit','direct','group')),
  proxy_group_id TEXT REFERENCES proxy_groups(id),
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((auth_type = 'api_key' AND secret_id IS NOT NULL AND account_ref IS NULL)
    OR (auth_type = 'oauth' AND account_ref IS NOT NULL AND secret_id IS NULL))
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_id TEXT NOT NULL REFERENCES secret_versions(id),
  position INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE client_providers (
  client_id TEXT NOT NULL REFERENCES clients(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  position INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(client_id, provider_id)
);
CREATE TABLE proxy_nodes (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES proxy_groups(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT,
  secret_id TEXT REFERENCES secret_versions(id),
  priority INTEGER NOT NULL,
  disabled INTEGER NOT NULL CHECK (disabled IN (0,1)),
  position INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE provider_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model TEXT NOT NULL,
  context_window INTEGER,
  position INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(provider_id, model)
);
CREATE TABLE model_routes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','client','provider')),
  client_id TEXT REFERENCES clients(id),
  provider_id TEXT REFERENCES providers(id),
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  restrict_providers INTEGER NOT NULL CHECK (restrict_providers IN (0,1)),
  position INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((scope = 'global' AND client_id IS NULL AND provider_id IS NULL)
    OR (scope = 'client' AND client_id IS NOT NULL AND provider_id IS NULL)
    OR (scope = 'provider' AND provider_id IS NOT NULL AND client_id IS NULL))
);
CREATE UNIQUE INDEX model_routes_global ON model_routes(name) WHERE scope = 'global' AND deleted_at IS NULL;
CREATE UNIQUE INDEX model_routes_client ON model_routes(client_id,name) WHERE scope = 'client' AND deleted_at IS NULL;
CREATE UNIQUE INDEX model_routes_provider ON model_routes(provider_id,name) WHERE scope = 'provider' AND deleted_at IS NULL;
CREATE TABLE model_route_providers (
  route_id TEXT NOT NULL REFERENCES model_routes(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  position INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(route_id, provider_id)
);
CREATE TABLE model_prices (
  id TEXT PRIMARY KEY,
  provider_model_id TEXT NOT NULL UNIQUE REFERENCES provider_models(id),
  pricing_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE settings (
  name TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  secret_id TEXT REFERENCES secret_versions(id)
);
CREATE TABLE config_snapshots (
  version INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_version INTEGER REFERENCES config_snapshots(version)
);
CREATE TABLE model_price_versions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL REFERENCES config_snapshots(version),
  model_price_id TEXT NOT NULL REFERENCES model_prices(id),
  price_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (revision, model_price_id)
);
CREATE INDEX model_price_history ON model_price_versions(model_price_id, revision DESC, created_at DESC, id);
ALTER TABLE requests RENAME COLUMN event_json TO details_json;
ALTER TABLE request_attempts RENAME COLUMN event_json TO details_json;

-- Retire document storage in dependency order. One-time conversion tables are no longer created.
DROP TABLE pricing_versions;
DROP TABLE config_revisions;
DROP TABLE control_state;
DROP TABLE oauth_clients;
