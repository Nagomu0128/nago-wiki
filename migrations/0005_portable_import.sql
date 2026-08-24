PRAGMA foreign_keys = ON;

ALTER TABLE imports ADD COLUMN workflow_source_json TEXT
  CHECK (workflow_source_json IS NULL OR json_valid(workflow_source_json));

CREATE TABLE import_request_idempotency (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key_hash)
) STRICT, WITHOUT ROWID;

CREATE INDEX import_request_idempotency_expires_idx
  ON import_request_idempotency(expires_at);

CREATE TABLE portable_maintenance_state (
  task TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
