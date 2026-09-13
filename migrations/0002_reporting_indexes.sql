-- A service filter can constrain time without also choosing a model.
CREATE INDEX requests_service_time
  ON requests(service_id, started_at DESC, request_id DESC);

-- Cover pending counts for every reporting dimension. Keep finished_at in
-- the index so SQLite can satisfy the predicate without reading request rows.
DROP INDEX requests_pending;
CREATE INDEX requests_pending
  ON requests(finished_at, started_at, service_id, key_id, client_id, model, kind, currency)
  WHERE finished_at IS NULL;
