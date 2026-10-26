-- Runtime host identity belongs to this deployment, not a transferred account.
CREATE TABLE oauth_host_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host_id TEXT NOT NULL UNIQUE
);
