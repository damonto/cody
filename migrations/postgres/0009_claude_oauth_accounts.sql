-- Admit the fixed Claude OAuth provider.
ALTER TABLE oauth_accounts DROP CONSTRAINT oauth_accounts_provider_type_check;
ALTER TABLE oauth_accounts ADD CONSTRAINT oauth_accounts_provider_type_check
  CHECK (provider_type IN ('antigravity', 'codex', 'claude'));
