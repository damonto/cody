-- Tokens and OAuth session material live only in encrypted Durable Object storage.
CREATE TABLE oauth_accounts (
  account_ref TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type = 'antigravity'),
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_accounts_provider ON oauth_accounts(provider_id, created_at);

-- Shared encrypted client registration store; all providers use CONFIG_ENCRYPTION_KEY.
CREATE TABLE oauth_clients (
  provider_type TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
