-- Historical requests did not record arrival time. Keep them out of the samples.
ALTER TABLE requests ADD COLUMN first_response_ms REAL;
ALTER TABLE usage_hourly ADD COLUMN first_response_sum REAL NOT NULL DEFAULT 0;
ALTER TABLE usage_hourly ADD COLUMN first_response_samples INTEGER NOT NULL DEFAULT 0;

-- These run atomically alongside the existing finish triggers. Each trigger
-- updates only its own counters, so their execution order does not matter.
CREATE TRIGGER requests_first_response_insert AFTER INSERT ON requests
WHEN NEW.finished_at IS NOT NULL AND NEW.first_response_ms IS NOT NULL
BEGIN
  INSERT INTO usage_hourly (hour, client_id, service_id, key_id, model, kind, currency, first_response_sum, first_response_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.service_id, NEW.key_id, NEW.model, NEW.kind, NEW.currency, NEW.first_response_ms, 1)
  ON CONFLICT (hour, client_id, service_id, key_id, model, kind, currency) DO UPDATE SET
    first_response_sum = first_response_sum + excluded.first_response_sum,
    first_response_samples = first_response_samples + excluded.first_response_samples;
END;

CREATE TRIGGER requests_first_response_update AFTER UPDATE ON requests
WHEN OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL AND NEW.first_response_ms IS NOT NULL
BEGIN
  INSERT INTO usage_hourly (hour, client_id, service_id, key_id, model, kind, currency, first_response_sum, first_response_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.service_id, NEW.key_id, NEW.model, NEW.kind, NEW.currency, NEW.first_response_ms, 1)
  ON CONFLICT (hour, client_id, service_id, key_id, model, kind, currency) DO UPDATE SET
    first_response_sum = first_response_sum + excluded.first_response_sum,
    first_response_samples = first_response_samples + excluded.first_response_samples;
END;
