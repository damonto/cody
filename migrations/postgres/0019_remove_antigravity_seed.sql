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

-- Enforce current provider types for writes and allow manual cleanup of older rows.
ALTER TABLE providers
  DROP CONSTRAINT providers_type_check,
  ADD CONSTRAINT providers_supported_type
    CHECK (type IN ('ai_gateway', 'codex', 'claude', 'xai')) NOT VALID;
ALTER TABLE oauth_accounts
  DROP CONSTRAINT oauth_accounts_provider_type_check,
  ADD CONSTRAINT oauth_accounts_supported_provider_type
    CHECK (provider_type IN ('codex', 'claude', 'xai')) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM providers WHERE type NOT IN ('ai_gateway', 'codex', 'claude', 'xai')) THEN
    ALTER TABLE providers VALIDATE CONSTRAINT providers_supported_type;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM oauth_accounts WHERE provider_type NOT IN ('codex', 'claude', 'xai')) THEN
    ALTER TABLE oauth_accounts VALIDATE CONSTRAINT oauth_accounts_supported_provider_type;
  END IF;
END;
$$;
