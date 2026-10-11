-- Remove the history/notes setting from provider entities.
UPDATE providers
SET settings_json = json_remove(settings_json, '$.supports_context_management')
WHERE json_type(settings_json, '$.supports_context_management') IS NOT NULL;
