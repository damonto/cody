-- Remove the unused default installed by 0015 on fresh databases.
-- Configured instances clean up their provider data separately.
DELETE FROM providers
WHERE type = 'antigravity'
  AND name = 'Antigravity'
  AND version = 0
  AND disabled = 1
  AND deleted_at IS NULL
  AND updated_at = created_at
  AND (SELECT version FROM config_meta WHERE id = 1) = 0
  AND NOT EXISTS (SELECT 1 FROM oauth_accounts WHERE provider_id = providers.id)
  AND NOT EXISTS (SELECT 1 FROM provider_credentials WHERE provider_id = providers.id)
  AND NOT EXISTS (SELECT 1 FROM provider_models WHERE provider_id = providers.id)
  AND NOT EXISTS (SELECT 1 FROM client_providers WHERE provider_id = providers.id)
  AND NOT EXISTS (SELECT 1 FROM model_routes WHERE provider_id = providers.id)
  AND NOT EXISTS (SELECT 1 FROM model_route_providers WHERE provider_id = providers.id);

-- Add write constraints without rebuilding tables referenced by configuration history.
-- An operator can still delete any rows left over from an earlier release.
CREATE TRIGGER providers_supported_type_insert BEFORE INSERT ON providers
WHEN NEW.type NOT IN ('ai_gateway', 'codex', 'claude', 'xai')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported provider type');
END;

CREATE TRIGGER providers_supported_type_update BEFORE UPDATE ON providers
WHEN NEW.type NOT IN ('ai_gateway', 'codex', 'claude', 'xai')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported provider type');
END;

CREATE TRIGGER oauth_accounts_supported_type_insert BEFORE INSERT ON oauth_accounts
WHEN NEW.provider_type NOT IN ('codex', 'claude', 'xai')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported OAuth provider type');
END;

CREATE TRIGGER oauth_accounts_supported_type_update BEFORE UPDATE ON oauth_accounts
WHEN NEW.provider_type NOT IN ('codex', 'claude', 'xai')
BEGIN
  SELECT RAISE(ABORT, 'Unsupported OAuth provider type');
END;
