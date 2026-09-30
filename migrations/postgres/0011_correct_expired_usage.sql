-- Maintenance outcomes are provisional; only a genuine terminal event settles them.
ALTER TABLE requests ADD COLUMN is_provisional INTEGER NOT NULL DEFAULT 0
  CHECK (is_provisional IN (0, 1));

-- Mark existing reaped rows once. Runtime ingestion uses the explicit flag,
-- independently of diagnostic wording or the client's visible outcome.
UPDATE requests SET is_provisional = 1
WHERE event_sequence = 2 AND finished_at IS NOT NULL
  AND outcome = 'failed' AND duration_ms IS NULL
  AND COALESCE((event_json::jsonb ->> 'diagnostic_code'), '') = 'worker_terminated'
  AND COALESCE((event_json::jsonb ->> 'observation_issue'), '') = 'stream_abandoned';

-- Replace only maintenance-inferred failures when genuine terminal usage arrives.
-- The existing finish triggers handle NULL -> finished; this handles corrections
-- without recounting the request or retaining its old routing/currency bucket.
CREATE FUNCTION requests_finish_correction_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE usage_hourly SET
    requests_count = requests_count - (1),
    success_count = success_count - (CASE WHEN OLD.outcome = 'success' THEN 1 ELSE 0 END),
    failed_count = failed_count - (CASE WHEN OLD.outcome = 'failed' THEN 1 ELSE 0 END),
    cancelled_count = cancelled_count - (CASE WHEN OLD.outcome = 'cancelled' THEN 1 ELSE 0 END),
    incomplete_count = incomplete_count - (CASE WHEN OLD.outcome = 'incomplete' THEN 1 ELSE 0 END),
    missing_usage_count = missing_usage_count - (CASE WHEN OLD.kind = 'inference' AND OLD.usage_status <> 'reported' THEN 1 ELSE 0 END),
    unpriced_count = unpriced_count - (CASE WHEN OLD.kind = 'inference' AND OLD.billing_status <> 'complete' THEN 1 ELSE 0 END),
    input_tokens = input_tokens - (COALESCE(OLD.input_tokens, 0)),
    uncached_input_tokens = uncached_input_tokens - (COALESCE(OLD.uncached_input_tokens, 0)),
    output_tokens = output_tokens - (COALESCE(OLD.output_tokens, 0)),
    cache_read_tokens = cache_read_tokens - (COALESCE(OLD.cache_read_tokens, 0)),
    cache_write_tokens = cache_write_tokens - (COALESCE(OLD.cache_write_tokens, 0)),
    cache_write_5m_tokens = cache_write_5m_tokens - (COALESCE(OLD.cache_write_5m_tokens, 0)),
    cache_write_1h_tokens = cache_write_1h_tokens - (COALESCE(OLD.cache_write_1h_tokens, 0)),
    reasoning_tokens = reasoning_tokens - (COALESCE(OLD.reasoning_tokens, 0)),
    reasoning_samples = reasoning_samples - (CASE WHEN OLD.reasoning_tokens IS NULL THEN 0 ELSE 1 END),
    cost_nano = cost_nano - (COALESCE(OLD.cost_nano, 0)),
    duration_sum = duration_sum - (COALESCE(OLD.duration_ms, 0)),
    duration_samples = duration_samples - (CASE WHEN OLD.duration_ms IS NULL THEN 0 ELSE 1 END),
    first_response_sum = first_response_sum - (COALESCE(OLD.first_response_ms, 0)),
    first_response_samples = first_response_samples - (CASE WHEN OLD.first_response_ms IS NULL THEN 0 ELSE 1 END),
    ttft_sum = ttft_sum - (COALESCE(OLD.ttft_ms, 0)),
    ttft_samples = ttft_samples - (CASE WHEN OLD.ttft_ms IS NULL THEN 0 ELSE 1 END),
    first_text_sum = first_text_sum - (COALESCE(OLD.first_text_ms, 0)),
    first_text_samples = first_text_samples - (CASE WHEN OLD.first_text_ms IS NULL THEN 0 ELSE 1 END)
  WHERE hour = (OLD.started_at / 3600000) * 3600000
    AND client_id = OLD.client_id AND provider_id = OLD.provider_id AND credential_id = OLD.credential_id AND model = OLD.model AND kind = OLD.kind AND currency = OLD.currency;

  DELETE FROM usage_hourly WHERE hour = (OLD.started_at / 3600000) * 3600000
    AND client_id = OLD.client_id AND provider_id = OLD.provider_id AND credential_id = OLD.credential_id AND model = OLD.model AND kind = OLD.kind AND currency = OLD.currency
    AND requests_count = 0 AND success_count = 0 AND failed_count = 0 AND cancelled_count = 0 AND incomplete_count = 0 AND missing_usage_count = 0 AND unpriced_count = 0 AND input_tokens = 0 AND uncached_input_tokens = 0 AND output_tokens = 0 AND cache_read_tokens = 0 AND cache_write_tokens = 0 AND cache_write_5m_tokens = 0 AND cache_write_1h_tokens = 0 AND reasoning_tokens = 0 AND reasoning_samples = 0 AND cost_nano = 0 AND duration_sum = 0 AND duration_samples = 0 AND first_response_sum = 0 AND first_response_samples = 0 AND ttft_sum = 0 AND ttft_samples = 0 AND first_text_sum = 0 AND first_text_samples = 0;

  INSERT INTO usage_hourly (hour, client_id, provider_id, credential_id, model, kind, currency, requests_count, success_count, failed_count, cancelled_count, incomplete_count, missing_usage_count, unpriced_count, input_tokens, uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, reasoning_tokens, reasoning_samples, cost_nano, duration_sum, duration_samples, first_response_sum, first_response_samples, ttft_sum, ttft_samples, first_text_sum, first_text_samples)
  VALUES ((NEW.started_at / 3600000) * 3600000, NEW.client_id, NEW.provider_id, NEW.credential_id, NEW.model, NEW.kind, NEW.currency, 1, CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'failed' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'cancelled' THEN 1 ELSE 0 END, CASE WHEN NEW.outcome = 'incomplete' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.usage_status <> 'reported' THEN 1 ELSE 0 END, CASE WHEN NEW.kind = 'inference' AND NEW.billing_status <> 'complete' THEN 1 ELSE 0 END, COALESCE(NEW.input_tokens, 0), COALESCE(NEW.uncached_input_tokens, 0), COALESCE(NEW.output_tokens, 0), COALESCE(NEW.cache_read_tokens, 0), COALESCE(NEW.cache_write_tokens, 0), COALESCE(NEW.cache_write_5m_tokens, 0), COALESCE(NEW.cache_write_1h_tokens, 0), COALESCE(NEW.reasoning_tokens, 0), CASE WHEN NEW.reasoning_tokens IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.cost_nano, 0), COALESCE(NEW.duration_ms, 0), CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.first_response_ms, 0), CASE WHEN NEW.first_response_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.ttft_ms, 0), CASE WHEN NEW.ttft_ms IS NULL THEN 0 ELSE 1 END, COALESCE(NEW.first_text_ms, 0), CASE WHEN NEW.first_text_ms IS NULL THEN 0 ELSE 1 END)
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
    first_response_sum = usage_hourly.first_response_sum + excluded.first_response_sum,
    first_response_samples = usage_hourly.first_response_samples + excluded.first_response_samples,
    ttft_sum = usage_hourly.ttft_sum + excluded.ttft_sum,
    ttft_samples = usage_hourly.ttft_samples + excluded.ttft_samples,
    first_text_sum = usage_hourly.first_text_sum + excluded.first_text_sum,
    first_text_samples = usage_hourly.first_text_samples + excluded.first_text_samples;
  RETURN NULL;
END;
$$;
CREATE TRIGGER requests_finish_correction AFTER UPDATE ON requests
FOR EACH ROW WHEN (OLD.is_provisional = 1 AND NEW.is_provisional = 0
  AND OLD.finished_at IS NOT NULL AND NEW.finished_at IS NOT NULL)
EXECUTE FUNCTION requests_finish_correction_fn();
