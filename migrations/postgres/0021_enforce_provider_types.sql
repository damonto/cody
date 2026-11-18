-- Enforce current provider types for writes and allow manual cleanup of older rows.
ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_type_check,
  DROP CONSTRAINT IF EXISTS providers_supported_type,
  ADD CONSTRAINT providers_supported_type
    CHECK (type IN ('ai_gateway', 'codex', 'claude')) NOT VALID;
ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_provider_type_check,
  DROP CONSTRAINT IF EXISTS oauth_accounts_supported_provider_type,
  ADD CONSTRAINT oauth_accounts_supported_provider_type
    CHECK (provider_type IN ('codex', 'claude')) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM providers WHERE type NOT IN ('ai_gateway', 'codex', 'claude')) THEN
    ALTER TABLE providers VALIDATE CONSTRAINT providers_supported_type;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM oauth_accounts WHERE provider_type NOT IN ('codex', 'claude')) THEN
    ALTER TABLE oauth_accounts VALIDATE CONSTRAINT oauth_accounts_supported_provider_type;
  END IF;
END;
$$;
