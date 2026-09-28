-- Admit the fixed xAI OAuth provider.
CREATE TABLE oauth_accounts_next (
  account_ref TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('antigravity', 'codex', 'claude', 'xai')),
  created_at INTEGER NOT NULL
);
INSERT INTO oauth_accounts_next (account_ref, provider_id, provider_type, created_at)
  SELECT account_ref, provider_id, provider_type, created_at FROM oauth_accounts;
DROP TABLE oauth_accounts;
ALTER TABLE oauth_accounts_next RENAME TO oauth_accounts;
CREATE INDEX oauth_accounts_provider ON oauth_accounts(provider_id, created_at);
