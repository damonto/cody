-- Standard backend (native Node.js and Vercel) object storage.
-- Durable coordination state lives here; Redis only holds locks and short-lived state.
-- Byte-order collation keeps key ranges and pagination identical to SQLite.
CREATE TABLE object_versions (
  namespace TEXT NOT NULL,
  object_name TEXT COLLATE "C" NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (namespace, object_name)
);
CREATE TABLE object_storage (
  namespace TEXT NOT NULL,
  object_name TEXT COLLATE "C" NOT NULL,
  item_key TEXT COLLATE "C" NOT NULL,
  item_value TEXT NOT NULL,
  PRIMARY KEY (namespace, object_name, item_key)
);
CREATE TABLE object_alarms (
  namespace TEXT NOT NULL,
  object_name TEXT COLLATE "C" NOT NULL,
  scheduled_at BIGINT NOT NULL,
  PRIMARY KEY (namespace, object_name)
);
CREATE INDEX object_alarms_due ON object_alarms (namespace, scheduled_at);
