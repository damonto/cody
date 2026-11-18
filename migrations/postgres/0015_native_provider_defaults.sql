-- Seed disabled native singletons so accounts can be authorized before editing settings.
-- Existing providers and immutable configuration snapshots are intentionally untouched.
WITH defaults(type, name, ordinal, settings_json) AS (
  VALUES
  ('codex', 'Codex', 1, '{"supports_websocket":true,"supports_context_management":false,"supports_web_search":true,"anthropic_1m_context":false,"emulate_claude_code":false,"account_selection":"round_robin","auto_consume_resets":false}'),
  ('claude', 'Claude', 2, '{"supports_websocket":false,"supports_context_management":false,"supports_web_search":false,"anthropic_1m_context":false,"emulate_claude_code":false,"account_selection":"round_robin","allow_extra_usage":false}')
), missing AS (
  SELECT defaults.* FROM defaults
  WHERE NOT EXISTS (
    SELECT 1 FROM providers
    WHERE providers.type = defaults.type AND providers.deleted_at IS NULL
  )
)
INSERT INTO providers (
  id, name, type, priority, disabled, position, proxy_group_id,
  settings_json, version, created_at, updated_at, deleted_at
)
SELECT
  gen_random_uuid()::text,
  name, type, 100, 1,
  (SELECT COALESCE(MAX(position), 0) FROM providers) + ROW_NUMBER() OVER (ORDER BY ordinal),
  NULL, settings_json, (SELECT version FROM config_meta WHERE id = 1),
  CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS BIGINT), CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS BIGINT), NULL
FROM missing;
