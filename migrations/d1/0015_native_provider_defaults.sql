-- Seed disabled native singletons so accounts can be authorized before editing settings.
-- Existing providers and immutable configuration snapshots are intentionally untouched.
WITH defaults(type, name, ordinal, settings_json) AS (
  VALUES
  ('antigravity', 'Antigravity', 0, '{"supports_websocket":false,"supports_context_management":false,"supports_web_search":false,"anthropic_1m_context":false,"emulate_claude_code":false,"account_selection":"round_robin"}'),
  ('codex', 'Codex', 1, '{"supports_websocket":true,"supports_context_management":false,"supports_web_search":true,"anthropic_1m_context":false,"emulate_claude_code":false,"account_selection":"round_robin","auto_consume_resets":false}'),
  ('claude', 'Claude', 2, '{"supports_websocket":false,"supports_context_management":false,"supports_web_search":false,"anthropic_1m_context":false,"emulate_claude_code":false,"account_selection":"round_robin","allow_extra_usage":false}'),
  ('xai', 'Xai', 3, '{"supports_websocket":false,"supports_context_management":false,"supports_web_search":false,"anthropic_1m_context":false,"emulate_claude_code":false,"account_selection":"round_robin","allow_extra_usage":false,"inject_x_search":false}')
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
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  name, type, 100, 1,
  (SELECT COALESCE(MAX(position), -1) FROM providers) + ROW_NUMBER() OVER (ORDER BY ordinal),
  NULL, settings_json, (SELECT version FROM config_meta WHERE id = 1),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM missing;
