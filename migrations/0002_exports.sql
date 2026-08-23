CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
  r2_key TEXT,
  plan_r2_key TEXT,
  multipart_upload_id TEXT,
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  archive_size INTEGER CHECK (archive_size IS NULL OR archive_size >= 0),
  archive_hash TEXT CHECK (archive_hash IS NULL OR length(archive_hash) = 64),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE INDEX exports_workspace_created_idx
  ON exports(workspace_id, created_at DESC);
CREATE INDEX exports_status_updated_idx ON exports(status, updated_at);

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
