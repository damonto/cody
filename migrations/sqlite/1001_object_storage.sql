-- Standard backend (native Node.js and Vercel) object storage. Never applied to D1.
-- Durable coordination state lives here; Redis only holds locks and short-lived state.
CREATE TABLE object_versions (
  namespace TEXT NOT NULL,
  object_name TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (namespace, object_name)
);
CREATE TABLE object_storage (
  namespace TEXT NOT NULL,
  object_name TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_value TEXT NOT NULL,
  PRIMARY KEY (namespace, object_name, item_key)
);
CREATE TABLE object_alarms (
  namespace TEXT NOT NULL,
  object_name TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, object_name)
);
CREATE INDEX object_alarms_due ON object_alarms (namespace, scheduled_at);
