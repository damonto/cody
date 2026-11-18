-- Add write constraints without rebuilding tables referenced by configuration history.
-- An operator can still delete any rows left over from an earlier release.
DROP TRIGGER IF EXISTS providers_supported_type_insert;
DROP TRIGGER IF EXISTS providers_supported_type_update;
DROP TRIGGER IF EXISTS oauth_accounts_supported_type_insert;
DROP TRIGGER IF EXISTS oauth_accounts_supported_type_update;

CREATE TRIGGER providers_supported_type_insert BEFORE INSERT ON providers
WHEN NEW.type NOT IN ('ai_gateway', 'codex', 'claude')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported provider type');
END;

CREATE TRIGGER providers_supported_type_update BEFORE UPDATE ON providers
WHEN NEW.type NOT IN ('ai_gateway', 'codex', 'claude')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported provider type');
END;

CREATE TRIGGER oauth_accounts_supported_type_insert BEFORE INSERT ON oauth_accounts
WHEN NEW.provider_type NOT IN ('codex', 'claude')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported OAuth provider type');
END;

CREATE TRIGGER oauth_accounts_supported_type_update BEFORE UPDATE ON oauth_accounts
WHEN NEW.provider_type NOT IN ('codex', 'claude')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported OAuth provider type');
END;
