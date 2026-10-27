-- Run once, with inference traffic and configuration writers stopped, after
-- deploying support for 30m/12h prices and applying schema migrations.
-- Existing configured amounts are preserved; this does NOT apply public price
-- multipliers or recalculate historical usage. Run against a backed-up database.

-- Preview affected current prices (including disabled Codex providers/models).
SELECT p.id AS provider_id, pm.model, mp.id AS price_id, mp.pricing_json
FROM model_prices mp
JOIN provider_models pm ON pm.id = mp.provider_model_id
JOIN providers p ON p.id = pm.provider_id
WHERE p.type = 'codex' AND p.deleted_at IS NULL
  AND pm.deleted_at IS NULL AND mp.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(mp.pricing_json::jsonb -> 'tiers') t
              WHERE t ? 'cache_write_5m' OR t ? 'cache_write_1h');

BEGIN;
DO $$
DECLARE
  state config_meta%ROWTYPE;
  current_snapshot jsonb;
  next_snapshot jsonb;
  next_prices jsonb;
  price_record record;
  rates jsonb;
  tiers jsonb;
  next_revision bigint;
  changed_count integer := 0;
  operation text := gen_random_uuid()::text;
  timestamp_ms bigint;
BEGIN
  SELECT * INTO STRICT state FROM config_meta WHERE id = 1 FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM model_prices mp
    JOIN provider_models pm ON pm.id = mp.provider_model_id
    JOIN providers p ON p.id = pm.provider_id
    WHERE p.type = 'codex' AND p.deleted_at IS NULL
      AND pm.deleted_at IS NULL AND mp.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(mp.pricing_json::jsonb -> 'tiers') t
                  WHERE t ? 'cache_write_5m' OR t ? 'cache_write_1h')
  ) THEN
    RAISE NOTICE 'No Codex cache duration prices to migrate';
    RETURN;
  END IF;

  SELECT config_json::jsonb INTO STRICT current_snapshot
  FROM config_snapshots WHERE version = state.version;
  -- Stop on an inconsistent source rather than publishing a partially compiled
  -- configuration. Secrets and all non-price snapshot fields stay unchanged.
  IF (current_snapshot ->> 'revision')::bigint IS DISTINCT FROM state.version
    OR jsonb_typeof(current_snapshot -> 'model_prices') IS DISTINCT FROM 'array'
    OR (SELECT count(*) FROM model_prices WHERE deleted_at IS NULL)
       <> jsonb_array_length(current_snapshot -> 'model_prices')
    OR EXISTS (
      SELECT 1 FROM model_prices mp
      LEFT JOIN provider_models pm ON pm.id = mp.provider_model_id AND pm.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT value FROM jsonb_array_elements(current_snapshot -> 'model_prices')
        WHERE value ->> 'id' = mp.id
      ) snapshot_price ON true
      LEFT JOIN model_price_versions pv ON pv.id = snapshot_price.value ->> 'version_id'
      WHERE mp.deleted_at IS NULL AND (
        snapshot_price.value IS NULL OR pm.id IS NULL OR pv.id IS NULL
        OR pv.model_price_id <> mp.id OR pv.revision <> state.version
        OR pv.price_json::jsonb IS DISTINCT FROM snapshot_price.value
        OR snapshot_price.value -> 'pricing' IS DISTINCT FROM mp.pricing_json::jsonb
        OR snapshot_price.value ->> 'provider_id' IS DISTINCT FROM pm.provider_id
        OR snapshot_price.value ->> 'model' IS DISTINCT FROM pm.model
      )
    ) THEN
    RAISE EXCEPTION 'Current entities, snapshot and price versions disagree; migration aborted';
  END IF;

  next_revision := state.version + 1;
  timestamp_ms := greatest(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint, state.updated_at + 1);
  FOR price_record IN
    SELECT mp.id, mp.pricing_json::jsonb AS pricing
    FROM model_prices mp
    JOIN provider_models pm ON pm.id = mp.provider_model_id
    JOIN providers p ON p.id = pm.provider_id
    WHERE p.type = 'codex' AND p.deleted_at IS NULL
      AND pm.deleted_at IS NULL AND mp.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(mp.pricing_json::jsonb -> 'tiers') t
                  WHERE t ? 'cache_write_5m' OR t ? 'cache_write_1h')
  LOOP
    SELECT jsonb_agg(
      (t.value - 'cache_write_5m' - 'cache_write_1h')
      || CASE WHEN NOT (t.value ? 'cache_write_30m') AND t.value ? 'cache_write_5m'
              THEN jsonb_build_object('cache_write_30m', t.value -> 'cache_write_5m') ELSE '{}'::jsonb END
      || CASE WHEN NOT (t.value ? 'cache_write_12h') AND t.value ? 'cache_write_1h'
              THEN jsonb_build_object('cache_write_12h', t.value -> 'cache_write_1h') ELSE '{}'::jsonb END
      ORDER BY t.ordinality
    ) INTO tiers FROM jsonb_array_elements(price_record.pricing -> 'tiers') WITH ORDINALITY t;
    rates := jsonb_set(price_record.pricing, '{tiers}', tiers);
    UPDATE model_prices SET pricing_json = rates::text, version = next_revision, updated_at = timestamp_ms
    WHERE id = price_record.id;
    changed_count := changed_count + 1;
  END LOOP;

  -- Normal configuration commits allocate a new version for every live price.
  SELECT jsonb_agg(
    jsonb_set(
      jsonb_set(price.value, '{pricing}', mp.pricing_json::jsonb),
      '{version_id}', to_jsonb(gen_random_uuid()::text)
    ) ORDER BY price.ordinality
  ) INTO next_prices
  FROM jsonb_array_elements(current_snapshot -> 'model_prices') WITH ORDINALITY price
  JOIN model_prices mp ON mp.id = price.value ->> 'id' AND mp.deleted_at IS NULL;
  next_snapshot := jsonb_set(jsonb_set(current_snapshot, '{revision}', to_jsonb(next_revision)), '{model_prices}', next_prices);
  IF octet_length(next_snapshot::text) > 1048576 THEN
    RAISE EXCEPTION 'Compiled configuration exceeds 1 MiB';
  END IF;
  INSERT INTO config_snapshots(version, config_json, actor, created_at, source_version)
  VALUES (next_revision, next_snapshot::text, 'sql:codex-cache-durations', timestamp_ms, NULL);
  INSERT INTO model_price_versions(id, revision, model_price_id, price_json, created_at)
  SELECT value ->> 'version_id', next_revision, value ->> 'id', value::text, timestamp_ms
  FROM jsonb_array_elements(next_prices);
  INSERT INTO config_operations(id, version, input_hash, actor, created_at)
  VALUES (operation, next_revision, encode(sha256(convert_to(next_snapshot::text, 'UTF8')), 'hex'), 'sql:codex-cache-durations', timestamp_ms);
  INSERT INTO audit_log(id, created_at, actor, action, revision)
  VALUES (operation, timestamp_ms, 'sql:codex-cache-durations', 'save_configuration', next_revision);
  UPDATE config_meta SET version = next_revision, operation_id = operation, updated_at = timestamp_ms
  WHERE id = 1 AND version = state.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configuration version changed'; END IF;
  RAISE NOTICE 'Migrated % Codex prices; configuration revision % -> %', changed_count, state.version, next_revision;
END;
$$;
COMMIT;

-- Verify current Codex entities and the committed snapshot agree. Every row
-- should have matches_snapshot = true and no legacy keys in its tiers.
SELECT p.id AS provider_id, pm.model, mp.pricing_json,
       mp.pricing_json::jsonb = snapshot_price.value -> 'pricing' AS matches_snapshot
FROM model_prices mp
JOIN provider_models pm ON pm.id = mp.provider_model_id
JOIN providers p ON p.id = pm.provider_id
JOIN config_meta meta ON meta.id = 1
JOIN config_snapshots s ON s.version = meta.version
CROSS JOIN LATERAL jsonb_array_elements(s.config_json::jsonb -> 'model_prices') snapshot_price
WHERE p.type = 'codex' AND p.deleted_at IS NULL
  AND pm.deleted_at IS NULL AND mp.deleted_at IS NULL
  AND snapshot_price.value ->> 'id' = mp.id;
