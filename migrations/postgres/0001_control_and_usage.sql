-- PostgreSQL translation of the D1 baseline. Keep in sync with ../0001_control_and_usage.sql.
CREATE TABLE control_state (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  draft_version BIGINT NOT NULL DEFAULT 0,
  draft_payload TEXT,
  published_revision BIGINT,
  updated_at BIGINT NOT NULL DEFAULT 0
);
INSERT INTO control_state (id) VALUES (1);

CREATE TABLE config_revisions (
  id BIGSERIAL PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  published_at BIGINT,
  actor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source_revision BIGINT
);
CREATE TABLE pricing_versions (
  id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL REFERENCES config_revisions(id),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX pricing_model_history ON pricing_versions(provider_id, model, created_at DESC);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  revision BIGINT
);

CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  event_sequence BIGINT NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  client_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  credential_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  requested_model TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL,
  protocol TEXT NOT NULL,
  transport TEXT NOT NULL,
  outcome TEXT NOT NULL,
  http_status BIGINT,
  duration_ms DOUBLE PRECISION,
  ttft_ms DOUBLE PRECISION,
  first_text_ms DOUBLE PRECISION,
  context_tokens BIGINT,
  context_window BIGINT,
  input_tokens BIGINT,
  uncached_input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  cache_write_5m_tokens BIGINT,
  cache_write_1h_tokens BIGINT,
  reasoning_tokens BIGINT,
  usage_status TEXT NOT NULL,
  billing_status TEXT NOT NULL,
  cost_nano BIGINT,
  event_json TEXT NOT NULL,
  first_response_ms DOUBLE PRECISION
);
CREATE INDEX requests_time ON requests(started_at DESC, request_id DESC);
CREATE INDEX requests_provider_model_time ON requests(provider_id, model, started_at DESC);
CREATE INDEX requests_client_time ON requests(client_id, started_at DESC);
-- A provider filter can constrain time without also choosing a model.
CREATE INDEX requests_provider_time
  ON requests(provider_id, started_at DESC, request_id DESC);
-- Cover pending counts without reading request rows.
CREATE INDEX requests_pending
  ON requests(finished_at, started_at, provider_id, credential_id, client_id, model, kind, currency)
  WHERE finished_at IS NULL;
CREATE TABLE request_attempts (
  request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
  attempt BIGINT NOT NULL,
  status BIGINT,
  duration_ms DOUBLE PRECISION NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY(request_id, attempt)
);
CREATE TABLE usage_hourly (
  hour BIGINT NOT NULL,
  client_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  requests_count BIGINT NOT NULL DEFAULT 0,
  success_count BIGINT NOT NULL DEFAULT 0,
  failed_count BIGINT NOT NULL DEFAULT 0,
  cancelled_count BIGINT NOT NULL DEFAULT 0,
  incomplete_count BIGINT NOT NULL DEFAULT 0,
  missing_usage_count BIGINT NOT NULL DEFAULT 0,
  unpriced_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  uncached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_5m_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_samples BIGINT NOT NULL DEFAULT 0,
  cost_nano BIGINT NOT NULL DEFAULT 0,
  duration_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_samples BIGINT NOT NULL DEFAULT 0,
  ttft_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  ttft_samples BIGINT NOT NULL DEFAULT 0,
  first_text_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  first_text_samples BIGINT NOT NULL DEFAULT 0,
  first_response_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  first_response_samples BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(hour, client_id, provider_id, credential_id, model, kind, currency)
);
-- Terminal-before-start delivery and duplicates both update the aggregate once.
CREATE FUNCTION requests_finish_insert_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO usage_hourly (hour, client_id, provider_id, credential_id, model, kind, currency, requests_count, success_count, failed_count, cancelled_count, incomplete_count, missing_usage_count, unpriced_count, input_tokens, uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, reasoning_samples, cost_nano, duration_sum, duration_samples, ttft_sum, ttft_samples, first_text_sum, first_text_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.provider_id, NEW.credential_id, NEW.model, NEW.kind, NEW.currency, 1, CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'failed' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'cancelled' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'incomplete' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.usage_status <> 'reported' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.billing_status <> 'complete' THEN 1 ELSE 0 END, COALESCE(NEW.input_tokens, 0), COALESCE(NEW.uncached_input_tokens, 0), COALESCE(NEW.output_tokens, 0), COALESCE(NEW.cache_read_tokens, 0), COALESCE(NEW.cache_write_tokens, 0), COALESCE(NEW.cache_write_5m_tokens, 0), COALESCE(NEW.cache_write_1h_tokens, 0), COALESCE(NEW.reasoning_tokens, 0), CASE WHEN NEW.reasoning_tokens IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.cost_nano, 0), COALESCE(NEW.duration_ms, 0), CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.ttft_ms, 0), CASE WHEN NEW.ttft_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.first_text_ms, 0), CASE WHEN NEW.first_text_ms IS NULL THEN 0 ELSE 1 END)
  ON CONFLICT (hour, client_id, provider_id, credential_id, model, kind, currency) DO UPDATE SET
    requests_count = usage_hourly.requests_count + excluded.requests_count,
    success_count = usage_hourly.success_count + excluded.success_count,
    failed_count = usage_hourly.failed_count + excluded.failed_count,
    cancelled_count = usage_hourly.cancelled_count + excluded.cancelled_count,
    incomplete_count = usage_hourly.incomplete_count + excluded.incomplete_count,
    missing_usage_count = usage_hourly.missing_usage_count + excluded.missing_usage_count,
    unpriced_count = usage_hourly.unpriced_count + excluded.unpriced_count,
    input_tokens = usage_hourly.input_tokens + excluded.input_tokens,
    uncached_input_tokens = usage_hourly.uncached_input_tokens + excluded.uncached_input_tokens,
    output_tokens = usage_hourly.output_tokens + excluded.output_tokens,
    cache_read_tokens = usage_hourly.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = usage_hourly.cache_write_tokens + excluded.cache_write_tokens,
    cache_write_5m_tokens = usage_hourly.cache_write_5m_tokens + excluded.cache_write_5m_tokens,
    cache_write_1h_tokens = usage_hourly.cache_write_1h_tokens + excluded.cache_write_1h_tokens,
    reasoning_tokens = usage_hourly.reasoning_tokens + excluded.reasoning_tokens,
    reasoning_samples = usage_hourly.reasoning_samples + excluded.reasoning_samples,
    cost_nano = usage_hourly.cost_nano + excluded.cost_nano,
    duration_sum = usage_hourly.duration_sum + excluded.duration_sum,
    duration_samples = usage_hourly.duration_samples + excluded.duration_samples,
    ttft_sum = usage_hourly.ttft_sum + excluded.ttft_sum,
    ttft_samples = usage_hourly.ttft_samples + excluded.ttft_samples,
    first_text_sum = usage_hourly.first_text_sum + excluded.first_text_sum,
    first_text_samples = usage_hourly.first_text_samples + excluded.first_text_samples;
  RETURN NULL;
END;
$$;
CREATE TRIGGER requests_finish_insert AFTER INSERT ON requests
FOR EACH ROW WHEN (NEW.finished_at IS NOT NULL)
EXECUTE FUNCTION requests_finish_insert_fn();
CREATE FUNCTION requests_finish_update_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO usage_hourly (hour, client_id, provider_id, credential_id, model, kind, currency, requests_count, success_count, failed_count, cancelled_count, incomplete_count, missing_usage_count, unpriced_count, input_tokens, uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, reasoning_samples, cost_nano, duration_sum, duration_samples, ttft_sum, ttft_samples, first_text_sum, first_text_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.provider_id, NEW.credential_id, NEW.model, NEW.kind, NEW.currency, 1, CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'failed' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'cancelled' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'incomplete' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.usage_status <> 'reported' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.billing_status <> 'complete' THEN 1 ELSE 0 END, COALESCE(NEW.input_tokens, 0), COALESCE(NEW.uncached_input_tokens, 0), COALESCE(NEW.output_tokens, 0), COALESCE(NEW.cache_read_tokens, 0), COALESCE(NEW.cache_write_tokens, 0), COALESCE(NEW.cache_write_5m_tokens, 0), COALESCE(NEW.cache_write_1h_tokens, 0), COALESCE(NEW.reasoning_tokens, 0), CASE WHEN NEW.reasoning_tokens IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.cost_nano, 0), COALESCE(NEW.duration_ms, 0), CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.ttft_ms, 0), CASE WHEN NEW.ttft_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.first_text_ms, 0), CASE WHEN NEW.first_text_ms IS NULL THEN 0 ELSE 1 END)
  ON CONFLICT (hour, client_id, provider_id, credential_id, model, kind, currency) DO UPDATE SET
    requests_count = usage_hourly.requests_count + excluded.requests_count,
    success_count = usage_hourly.success_count + excluded.success_count,
    failed_count = usage_hourly.failed_count + excluded.failed_count,
    cancelled_count = usage_hourly.cancelled_count + excluded.cancelled_count,
    incomplete_count = usage_hourly.incomplete_count + excluded.incomplete_count,
    missing_usage_count = usage_hourly.missing_usage_count + excluded.missing_usage_count,
    unpriced_count = usage_hourly.unpriced_count + excluded.unpriced_count,
    input_tokens = usage_hourly.input_tokens + excluded.input_tokens,
    uncached_input_tokens = usage_hourly.uncached_input_tokens + excluded.uncached_input_tokens,
    output_tokens = usage_hourly.output_tokens + excluded.output_tokens,
    cache_read_tokens = usage_hourly.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = usage_hourly.cache_write_tokens + excluded.cache_write_tokens,
    cache_write_5m_tokens = usage_hourly.cache_write_5m_tokens + excluded.cache_write_5m_tokens,
    cache_write_1h_tokens = usage_hourly.cache_write_1h_tokens + excluded.cache_write_1h_tokens,
    reasoning_tokens = usage_hourly.reasoning_tokens + excluded.reasoning_tokens,
    reasoning_samples = usage_hourly.reasoning_samples + excluded.reasoning_samples,
    cost_nano = usage_hourly.cost_nano + excluded.cost_nano,
    duration_sum = usage_hourly.duration_sum + excluded.duration_sum,
    duration_samples = usage_hourly.duration_samples + excluded.duration_samples,
    ttft_sum = usage_hourly.ttft_sum + excluded.ttft_sum,
    ttft_samples = usage_hourly.ttft_samples + excluded.ttft_samples,
    first_text_sum = usage_hourly.first_text_sum + excluded.first_text_sum,
    first_text_samples = usage_hourly.first_text_samples + excluded.first_text_samples;
  RETURN NULL;
END;
$$;
CREATE TRIGGER requests_finish_update AFTER UPDATE ON requests
FOR EACH ROW WHEN (OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL)
EXECUTE FUNCTION requests_finish_update_fn();

-- These run atomically alongside the existing finish triggers. Each trigger
-- updates only its own counters, so their execution order does not matter.
CREATE FUNCTION requests_first_response_insert_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO usage_hourly (hour, client_id, provider_id, credential_id, model, kind, currency, first_response_sum, first_response_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.provider_id, NEW.credential_id, NEW.model, NEW.kind, NEW.currency, NEW.first_response_ms, 1)
  ON CONFLICT (hour, client_id, provider_id, credential_id, model, kind, currency) DO UPDATE SET
    first_response_sum = usage_hourly.first_response_sum + excluded.first_response_sum,
    first_response_samples = usage_hourly.first_response_samples + excluded.first_response_samples;
  RETURN NULL;
END;
$$;
CREATE TRIGGER requests_first_response_insert AFTER INSERT ON requests
FOR EACH ROW WHEN (NEW.finished_at IS NOT NULL AND NEW.first_response_ms IS NOT NULL)
EXECUTE FUNCTION requests_first_response_insert_fn();

CREATE FUNCTION requests_first_response_update_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO usage_hourly (hour, client_id, provider_id, credential_id, model, kind, currency, first_response_sum, first_response_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.provider_id, NEW.credential_id, NEW.model, NEW.kind, NEW.currency, NEW.first_response_ms, 1)
  ON CONFLICT (hour, client_id, provider_id, credential_id, model, kind, currency) DO UPDATE SET
    first_response_sum = usage_hourly.first_response_sum + excluded.first_response_sum,
    first_response_samples = usage_hourly.first_response_samples + excluded.first_response_samples;
  RETURN NULL;
END;
$$;
CREATE TRIGGER requests_first_response_update AFTER UPDATE ON requests
FOR EACH ROW WHEN (OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL AND NEW.first_response_ms IS NOT NULL)
EXECUTE FUNCTION requests_first_response_update_fn();
