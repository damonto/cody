-- D1 is the control-plane source of truth; configuration payloads are encrypted.
CREATE TABLE control_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draft_version INTEGER NOT NULL DEFAULT 0,
  draft_payload TEXT,
  published_revision INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO control_state (id) VALUES (1);

CREATE TABLE config_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  actor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source_revision INTEGER
);
CREATE TABLE pricing_versions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL REFERENCES config_revisions(id),
  service_id TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pricing_model_history ON pricing_versions(service_id, model, created_at DESC);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER
);

CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  event_sequence INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  client_id TEXT NOT NULL DEFAULT '',
  service_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  requested_model TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL,
  protocol TEXT NOT NULL,
  transport TEXT NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  duration_ms REAL,
  ttft_ms REAL,
  first_text_ms REAL,
  context_tokens INTEGER,
  context_window INTEGER,
  input_tokens INTEGER,
  uncached_input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  reasoning_tokens INTEGER,
  usage_status TEXT NOT NULL,
  billing_status TEXT NOT NULL,
  cost_nano INTEGER,
  event_json TEXT NOT NULL
);
CREATE INDEX requests_time ON requests(started_at DESC, request_id DESC);
CREATE INDEX requests_service_model_time ON requests(service_id, model, started_at DESC);
CREATE INDEX requests_client_time ON requests(client_id, started_at DESC);
CREATE INDEX requests_pending ON requests(started_at) WHERE finished_at IS NULL;
CREATE TABLE request_attempts (
  request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status INTEGER,
  duration_ms REAL NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY(request_id, attempt)
);
CREATE TABLE usage_hourly (
  hour INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  requests_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  missing_usage_count INTEGER NOT NULL DEFAULT 0,
  unpriced_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_samples INTEGER NOT NULL DEFAULT 0,
  cost_nano INTEGER NOT NULL DEFAULT 0,
  duration_sum REAL NOT NULL DEFAULT 0,
  duration_samples INTEGER NOT NULL DEFAULT 0,
  ttft_sum REAL NOT NULL DEFAULT 0,
  ttft_samples INTEGER NOT NULL DEFAULT 0,
  first_text_sum REAL NOT NULL DEFAULT 0,
  first_text_samples INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(hour, client_id, service_id, key_id, model, kind, currency)
);
-- Terminal-before-start delivery and duplicates both update the aggregate once.
CREATE TRIGGER requests_finish_insert AFTER INSERT ON requests
WHEN NEW.finished_at IS NOT NULL
BEGIN
  INSERT INTO usage_hourly (hour, client_id, service_id, key_id, model, kind, currency, requests_count, success_count, failed_count, cancelled_count, incomplete_count, missing_usage_count, unpriced_count, input_tokens, uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, reasoning_samples, cost_nano, duration_sum, duration_samples, ttft_sum, ttft_samples, first_text_sum, first_text_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.service_id, NEW.key_id, NEW.model, NEW.kind, NEW.currency, 1, CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'failed' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'cancelled' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'incomplete' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.usage_status <> 'reported' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.billing_status <> 'complete' THEN 1 ELSE 0 END, COALESCE(NEW.input_tokens, 0), COALESCE(NEW.uncached_input_tokens, 0), COALESCE(NEW.output_tokens, 0), COALESCE(NEW.cache_read_tokens, 0), COALESCE(NEW.cache_write_tokens, 0), COALESCE(NEW.cache_write_5m_tokens, 0), COALESCE(NEW.cache_write_1h_tokens, 0), COALESCE(NEW.reasoning_tokens, 0), CASE WHEN NEW.reasoning_tokens IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.cost_nano, 0), COALESCE(NEW.duration_ms, 0), CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.ttft_ms, 0), CASE WHEN NEW.ttft_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.first_text_ms, 0), CASE WHEN NEW.first_text_ms IS NULL THEN 0 ELSE 1 END)
  ON CONFLICT (hour, client_id, service_id, key_id, model, kind, currency) DO UPDATE SET
    requests_count = requests_count + excluded.requests_count,
    success_count = success_count + excluded.success_count,
    failed_count = failed_count + excluded.failed_count,
    cancelled_count = cancelled_count + excluded.cancelled_count,
    incomplete_count = incomplete_count + excluded.incomplete_count,
    missing_usage_count = missing_usage_count + excluded.missing_usage_count,
    unpriced_count = unpriced_count + excluded.unpriced_count,
    input_tokens = input_tokens + excluded.input_tokens,
    uncached_input_tokens = uncached_input_tokens + excluded.uncached_input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    cache_write_5m_tokens = cache_write_5m_tokens + excluded.cache_write_5m_tokens,
    cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    reasoning_samples = reasoning_samples + excluded.reasoning_samples,
    cost_nano = cost_nano + excluded.cost_nano,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_samples = duration_samples + excluded.duration_samples,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_samples = ttft_samples + excluded.ttft_samples,
    first_text_sum = first_text_sum + excluded.first_text_sum,
    first_text_samples = first_text_samples + excluded.first_text_samples;
END;
CREATE TRIGGER requests_finish_update AFTER UPDATE ON requests
WHEN OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL
BEGIN
  INSERT INTO usage_hourly (hour, client_id, service_id, key_id, model, kind, currency, requests_count, success_count, failed_count, cancelled_count, incomplete_count, missing_usage_count, unpriced_count, input_tokens, uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, reasoning_samples, cost_nano, duration_sum, duration_samples, ttft_sum, ttft_samples, first_text_sum, first_text_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.service_id, NEW.key_id, NEW.model, NEW.kind, NEW.currency, 1, CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'failed' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'cancelled' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'incomplete' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.usage_status <> 'reported' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.billing_status <> 'complete' THEN 1 ELSE 0 END, COALESCE(NEW.input_tokens, 0), COALESCE(NEW.uncached_input_tokens, 0), COALESCE(NEW.output_tokens, 0), COALESCE(NEW.cache_read_tokens, 0), COALESCE(NEW.cache_write_tokens, 0), COALESCE(NEW.cache_write_5m_tokens, 0), COALESCE(NEW.cache_write_1h_tokens, 0), COALESCE(NEW.reasoning_tokens, 0), CASE WHEN NEW.reasoning_tokens IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.cost_nano, 0), COALESCE(NEW.duration_ms, 0), CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.ttft_ms, 0), CASE WHEN NEW.ttft_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.first_text_ms, 0), CASE WHEN NEW.first_text_ms IS NULL THEN 0 ELSE 1 END)
  ON CONFLICT (hour, client_id, service_id, key_id, model, kind, currency) DO UPDATE SET
    requests_count = requests_count + excluded.requests_count,
    success_count = success_count + excluded.success_count,
    failed_count = failed_count + excluded.failed_count,
    cancelled_count = cancelled_count + excluded.cancelled_count,
    incomplete_count = incomplete_count + excluded.incomplete_count,
    missing_usage_count = missing_usage_count + excluded.missing_usage_count,
    unpriced_count = unpriced_count + excluded.unpriced_count,
    input_tokens = input_tokens + excluded.input_tokens,
    uncached_input_tokens = uncached_input_tokens + excluded.uncached_input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    cache_write_5m_tokens = cache_write_5m_tokens + excluded.cache_write_5m_tokens,
    cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    reasoning_samples = reasoning_samples + excluded.reasoning_samples,
    cost_nano = cost_nano + excluded.cost_nano,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_samples = duration_samples + excluded.duration_samples,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_samples = ttft_samples + excluded.ttft_samples,
    first_text_sum = first_text_sum + excluded.first_text_sum,
    first_text_samples = first_text_samples + excluded.first_text_samples;
END;
