-- Remove the history/notes setting from provider entities.
UPDATE providers
SET settings_json = (settings_json::jsonb - 'supports_context_management')::text
WHERE settings_json::jsonb ? 'supports_context_management';
